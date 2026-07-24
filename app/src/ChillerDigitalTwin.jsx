import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine
} from "recharts";
import * as THREE from "three";
import {
  Activity, AlertTriangle, AlertOctagon, Settings2, Radio, Zap, Snowflake,
  Flame, TrendingUp, CheckCircle2, XCircle, Send, RotateCw, Sliders,
  LayoutGrid, Box as BoxIcon, Bell, Wrench, Droplets, Wind, Play, RotateCcw,
  Square, DollarSign, Sparkles, ZoomIn, ZoomOut, ChevronRight,
} from "lucide-react";

/* ============================================================================
   THEME — control-room instrumentation palette
============================================================================ */
const THEME = {
  bg: "#0A0E17",
  bgAlt: "#0D1320",
  panel: "#111927",
  panel2: "#0E1521",
  border: "#1E2A3D",
  borderLit: "#2A3A52",
  text: "#E7ECF3",
  textDim: "#7C8CA6",
  textFaint: "#4C5A72",
  cyan: "#3FD6C4",
  cyanDim: "#1D6E66",
  amber: "#F2A93B",
  red: "#EF4B52",
  green: "#3ADB88",
  hot: "#FF6A4D",
  blue: "#5B8DEF",
  purple: "#9B7BF0",
  mono: "'SFMono-Regular', 'JetBrains Mono', Menlo, Consolas, monospace",
  sans: "-apple-system, 'Segoe UI', system-ui, sans-serif",
};

const TON_TO_KW = 3.517;

function formatUSD(n) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function severityColor(level) {
  return level === "critical" ? THEME.red : level === "warning" ? THEME.amber : THEME.green;
}

/* ============================================================================
   PREDICTIVE FORECAST
   Fits a simple linear trend to recent kW/ton-deviation history and projects
   forward to estimate when the plant would cross the warning/critical
   thresholds if the drift continues unaddressed. Each history sample is
   treated as ≈1 hour of real telemetry (a typical BMS trend-log interval) —
   an explicit, illustrative assumption, consistent with the rest of this
   prototype's numbers.
============================================================================ */
const FORECAST_MIN_SAMPLES = 3;
const FORECAST_WINDOW = 15;
const HOURS_PER_SAMPLE = 1;

function linearRegressionSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den; // deviation-% change per sample
}

function computeForecast(history, currentDeviationPct) {
  if (history.length < FORECAST_MIN_SAMPLES) return { ready: false };

  const recent = history.slice(-FORECAST_WINDOW);
  const deviations = recent.map((h) => (h.twinKw > 0 ? ((h.actualKw - h.twinKw) / h.twinKw) * 100 : 0));
  const slope = linearRegressionSlope(deviations) * HOURS_PER_SAMPLE; // %/hour

  const direction = slope > 0.15 ? "worsening" : slope < -0.15 ? "improving" : "stable";

  let hoursToWarning = null, hoursToCritical = null;
  if (slope > 0.001) {
    if (currentDeviationPct < 8) hoursToWarning = (8 - currentDeviationPct) / slope;
    if (currentDeviationPct < 18) hoursToCritical = (18 - currentDeviationPct) / slope;
  }

  return { ready: true, slope, direction, hoursToWarning, hoursToCritical };
}

function formatForecastTime(hours) {
  if (hours == null) return null;
  if (hours < 1) return "<1 hour";
  if (hours < 48) return `~${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`;
  return `~${(hours / 24).toFixed(1)} days`;
}

// Synthesized three-beep alarm tone (Web Audio API) — no external audio asset needed.
function playAlarmTone() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const beep = (startTime) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.15, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + 0.2);
    };
    const now = ctx.currentTime;
    beep(now);
    beep(now + 0.25);
    beep(now + 0.5);
    setTimeout(() => ctx.close(), 1200);
  } catch {
    // audio unavailable/blocked — the visual alarm banner still shows
  }
}

/* ============================================================================
   SCIENTIFIC MODEL
   Second-law (Carnot-referenced) chiller performance model.
   COP_actual = eta_2nd * COP_carnot, where COP_carnot = Tevap_K / (Tcond_K - Tevap_K)
   eta_2nd (second-law / exergetic efficiency) typically 0.35–0.55 for real
   centrifugal/screw chillers — degraded by fouling, wear, and charge loss.
   Evaporating temp = leaving chilled-water temp − evaporator approach
   Condensing temp  = entering condenser-water temp + condenser approach
   Reference: ASHRAE Fundamentals, chiller diagnostics literature on
   exergetic-efficiency-based condition monitoring.
============================================================================ */
function carnotCOP(TevapC, TcondC) {
  const TevapK = TevapC + 273.15;
  const TcondK = TcondC + 273.15;
  const denom = TcondK - TevapK;
  if (denom <= 0.2) return 25; // degenerate/near-zero lift guard
  return TevapK / denom;
}

function computeCyclePerformance({
  chwLeavingSP, cwEnteringSP, loadPct, designTons,
  evapApproachBase, condApproachBase, eta2ndBase,
  evapFouling, condFouling, refrigerantLoss, compressorWear, noise = 0,
}) {
  // fault contributions (0-100 sliders -> physical degradation)
  const evapApproach = evapApproachBase + (evapFouling / 100) * 4.0 + (refrigerantLoss / 100) * 1.6;
  const condApproach = condApproachBase + (condFouling / 100) * 5.0;
  const etaPenalty =
    (compressorWear / 100) * 0.20 +
    (refrigerantLoss / 100) * 0.28 +
    (evapFouling / 100) * 0.06 +
    (condFouling / 100) * 0.06;
  const eta2nd = Math.max(0.14, eta2ndBase - etaPenalty);

  const Tevap = chwLeavingSP - evapApproach + noise;
  const Tcond = cwEnteringSP + condApproach + noise;

  const copCarnot = carnotCOP(Tevap, Tcond);
  const cop = Math.max(1.1, copCarnot * eta2nd);

  const coolingLoadTons = designTons * (loadPct / 100);
  const coolingLoadKW = coolingLoadTons * TON_TO_KW;
  const compressorPowerKW = coolingLoadKW / cop;
  const kwPerTon = coolingLoadTons > 0.1 ? compressorPowerKW / coolingLoadTons : 0;

  return {
    Tevap, Tcond, copCarnot, cop, eta2nd,
    coolingLoadTons, coolingLoadKW, compressorPowerKW, kwPerTon,
    evapApproach, condApproach,
  };
}

// Metadata for the plain-language diagnostic narrative — one entry per fault
// slider, keyed the same way as the `faults` state.
const FAULT_CAUSES = {
  evapFouling: {
    symptom: (actual, baseline) =>
      `evaporator approach has widened to ${actual.evapApproach.toFixed(1)}°C (baseline ~${baseline.evapApproachBase.toFixed(1)}°C), consistent with evaporator tube fouling`,
    action: "schedule evaporator tube cleaning",
  },
  condFouling: {
    symptom: (actual, baseline) =>
      `condenser approach has widened to ${actual.condApproach.toFixed(1)}°C (baseline ~${baseline.condApproachBase.toFixed(1)}°C), consistent with condenser tube fouling`,
    action: "schedule condenser tube cleaning and check cooling-tower water treatment",
  },
  refrigerantLoss: {
    symptom: (actual) =>
      `evaporator approach has widened to ${actual.evapApproach.toFixed(1)}°C and second-law efficiency has dropped to ${(actual.eta2nd * 100).toFixed(0)}%, consistent with refrigerant charge loss`,
    action: "inspect for refrigerant leaks and recharge to spec",
  },
  compressorWear: {
    symptom: (actual, baseline) =>
      `second-law efficiency has dropped to ${(actual.eta2nd * 100).toFixed(0)}% (baseline ~${(baseline.eta2ndBase * 100).toFixed(0)}%), consistent with compressor bearing/valve wear`,
    action: "schedule a compressor bearing/valve inspection",
  },
};

function buildDiagnosticNarrative({ chillerName, alertLevel, deviationPct, dominantCauseKey, actual, baseline, costImpact, forecast }) {
  const trendingWorse = forecast?.ready && forecast.direction === "worsening";

  if (alertLevel === "ok" || !dominantCauseKey) {
    let detail = `Actual kW/ton is within ${Math.abs(deviationPct).toFixed(1)}% of the digital-twin baseline — no corrective action needed right now.`;
    if (trendingWorse && forecast.hoursToWarning != null) {
      detail += ` Trend is drifting upward — projected to reach the warning threshold in ${formatForecastTime(forecast.hoursToWarning)} if it continues.`;
    }
    return {
      headline: `${chillerName} is operating within its expected performance envelope.`,
      detail,
    };
  }
  const cause = FAULT_CAUSES[dominantCauseKey];
  const severityWord = alertLevel === "critical" ? "Critical" : "Warning";
  const costClause = costImpact.perMonth > 10
    ? `, an estimated ${formatUSD(costImpact.perMonth)}/month in excess energy cost if unaddressed`
    : "";
  let detail = `Efficiency is running ${deviationPct.toFixed(1)}% above the healthy digital-twin baseline${costClause}. Recommended action: ${cause.action}.`;
  if (trendingWorse && alertLevel === "warning" && forecast.hoursToCritical != null) {
    detail += ` At the current rate of drift, projected to reach the critical threshold in ${formatForecastTime(forecast.hoursToCritical)}.`;
  }
  return {
    headline: `${severityWord}: ${cause.symptom(actual, baseline)}.`,
    detail,
  };
}

// Simple chilled-water-reset optimizer heuristic (classic energy-saving strategy)
function recommendChwSetpoint(loadPct, currentSP) {
  // Raise supply temp when load is light — reduces lift, improves COP.
  const maxReset = 2.2;
  const resetAmount = loadPct < 40 ? maxReset : loadPct < 65 ? maxReset * 0.5 : 0;
  const target = Math.min(10, 6.7 + resetAmount);
  return { target: Number(target.toFixed(2)), resetAmount: Number(resetAmount.toFixed(2)) };
}

/* ============================================================================
   SMALL UI PRIMITIVES
============================================================================ */
function Panel({ title, icon: Icon, right, children, style }) {
  return (
    <div style={{ background: THEME.panel, border: `1px solid ${THEME.border}`, borderRadius: 10, ...style }}>
      {title && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px", borderBottom: `1px solid ${THEME.border}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {Icon && <Icon size={14} color={THEME.textDim} />}
            <span style={{ fontFamily: THEME.mono, fontSize: 11, letterSpacing: "0.08em", color: THEME.textDim, textTransform: "uppercase" }}>
              {title}
            </span>
          </div>
          {right}
        </div>
      )}
      <div style={{ padding: 14 }}>{children}</div>
    </div>
  );
}

function StatPill({ label, value, unit, color }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <span style={{ fontFamily: THEME.mono, fontSize: 20, fontWeight: 600, color: color || THEME.text }}>
        {value}<span style={{ fontSize: 11, color: THEME.textDim, marginLeft: 3 }}>{unit}</span>
      </span>
    </div>
  );
}

function polarPoint(cx, cy, r, angleDeg) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
function arcPath(cx, cy, r, startDeg, endDeg) {
  const s = polarPoint(cx, cy, r, endDeg);
  const e = polarPoint(cx, cy, r, startDeg);
  const large = endDeg - startDeg <= 180 ? 0 : 1;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 0 ${e.x} ${e.y}`;
}

function GaugeMeter({ label, value, min, max, unit, zones, decimals = 2 }) {
  const clamped = Math.min(max, Math.max(min, value));
  const frac = (clamped - min) / (max - min);
  const sweep = 220; // degrees of active arc, centered
  const start = -sweep / 2;
  const end = sweep / 2;
  const valueDeg = start + frac * sweep;
  let color = THEME.green;
  if (zones) {
    for (const z of zones) if (clamped >= z.from) color = z.color;
  }
  const cx = 60, cy = 62, r = 46;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <svg width="120" height="80" viewBox="0 0 120 80">
        <path d={arcPath(cx, cy, r, start, end)} stroke={THEME.border} strokeWidth="8" fill="none" strokeLinecap="round" />
        <path d={arcPath(cx, cy, r, start, valueDeg)} stroke={color} strokeWidth="8" fill="none" strokeLinecap="round" />
        <text x={cx} y={cy - 4} textAnchor="middle" fontFamily={THEME.mono} fontSize="18" fontWeight="700" fill={THEME.text}>
          {clamped.toFixed(decimals)}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" fontFamily={THEME.mono} fontSize="9" fill={THEME.textDim}>{unit}</text>
      </svg>
      <span style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textDim, textTransform: "uppercase", letterSpacing: "0.06em", marginTop: -6 }}>{label}</span>
    </div>
  );
}

function Slider({ label, value, min, max, step = 0.1, unit, onChange, color, decimals }) {
  const dp = decimals != null ? decimals : (step < 1 ? 1 : 0);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontFamily: THEME.mono, fontSize: 11, color: THEME.textDim }}>{label}</span>
        <span style={{ fontFamily: THEME.mono, fontSize: 11, color: color || THEME.cyan }}>{value.toFixed(dp)}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: color || THEME.cyan }}
      />
    </div>
  );
}

function SeverityBadge({ severity }) {
  const map = {
    critical: { c: THEME.red, t: "CRITICAL" },
    warning: { c: THEME.amber, t: "WARNING" },
    info: { c: THEME.blue, t: "INFO" },
    ok: { c: THEME.green, t: "NORMAL" },
  };
  const s = map[severity] || map.info;
  return (
    <span style={{
      fontFamily: THEME.mono, fontSize: 9, fontWeight: 700, color: s.c,
      border: `1px solid ${s.c}55`, background: `${s.c}18`, borderRadius: 4,
      padding: "2px 6px", letterSpacing: "0.05em",
    }}>{s.t}</span>
  );
}

/* ============================================================================
   2D SCHEMATIC — animated refrigeration loop (signature element)
============================================================================ */
function Schematic2D({ Tevap, Tcond, running, alertLevel }) {
  const loopColor = alertLevel === "critical" ? THEME.red : alertLevel === "warning" ? THEME.amber : THEME.cyan;
  return (
    <svg viewBox="0 0 720 300" width="100%" height="300">
      <defs>
        <linearGradient id="hotline" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={THEME.hot} />
          <stop offset="100%" stopColor={THEME.amber} />
        </linearGradient>
      </defs>

      {/* Evaporator */}
      <rect x="40" y="120" width="150" height="60" rx="8" fill={THEME.panel2} stroke={loopColor} strokeWidth="1.5" />
      <text x="115" y="145" textAnchor="middle" fill={THEME.text} fontFamily={THEME.sans} fontSize="12" fontWeight="600">Evaporator</text>
      <text x="115" y="163" textAnchor="middle" fill={THEME.cyan} fontFamily={THEME.mono} fontSize="12">{Tevap.toFixed(1)}°C</text>

      {/* Compressor */}
      <circle cx="360" cy="80" r="38" fill={THEME.panel2} stroke={loopColor} strokeWidth="1.5" />
      <text x="360" y="76" textAnchor="middle" fill={THEME.text} fontFamily={THEME.sans} fontSize="11" fontWeight="600">Compressor</text>
      <text x="360" y="92" textAnchor="middle" fill={THEME.hot} fontFamily={THEME.mono} fontSize="10">▲ P/T</text>

      {/* Condenser */}
      <rect x="530" y="120" width="150" height="60" rx="8" fill={THEME.panel2} stroke={loopColor} strokeWidth="1.5" />
      <text x="605" y="145" textAnchor="middle" fill={THEME.text} fontFamily={THEME.sans} fontSize="12" fontWeight="600">Condenser</text>
      <text x="605" y="163" textAnchor="middle" fill={THEME.hot} fontFamily={THEME.mono} fontSize="12">{Tcond.toFixed(1)}°C</text>

      {/* Expansion valve */}
      <polygon points="345,240 375,240 360,215" fill={THEME.panel2} stroke={loopColor} strokeWidth="1.5" />
      <text x="360" y="262" textAnchor="middle" fill={THEME.textDim} fontFamily={THEME.sans} fontSize="10">Exp. Valve</text>

      {/* Pipes: suction (evap->comp), discharge (comp->cond), liquid (cond->valve), low-side (valve->evap) */}
      <path d="M 115 120 L 115 90 L 322 90" fill="none" stroke={THEME.cyan} strokeWidth="3" strokeDasharray="6 6">
        {running && <animate attributeName="stroke-dashoffset" from="0" to="-24" dur="0.9s" repeatCount="indefinite" />}
      </path>
      <path d="M 398 90 L 605 90 L 605 120" fill="none" stroke={THEME.hot} strokeWidth="3" strokeDasharray="6 6">
        {running && <animate attributeName="stroke-dashoffset" from="0" to="-24" dur="0.7s" repeatCount="indefinite" />}
      </path>
      <path d="M 605 180 L 605 240 L 375 240" fill="none" stroke={THEME.amber} strokeWidth="3" strokeDasharray="6 6">
        {running && <animate attributeName="stroke-dashoffset" from="0" to="-24" dur="0.9s" repeatCount="indefinite" />}
      </path>
      <path d="M 345 240 L 115 240 L 115 180" fill="none" stroke={THEME.blue} strokeWidth="3" strokeDasharray="6 6">
        {running && <animate attributeName="stroke-dashoffset" from="0" to="-24" dur="1.1s" repeatCount="indefinite" />}
      </path>

      <text x="20" y="205" fill={THEME.textFaint} fontFamily={THEME.mono} fontSize="9">SUCTION</text>
      <text x="470" y="70" fill={THEME.textFaint} fontFamily={THEME.mono} fontSize="9">DISCHARGE</text>
      <text x="470" y="205" fill={THEME.textFaint} fontFamily={THEME.mono} fontSize="9">LIQUID</text>
      <text x="180" y="270" fill={THEME.textFaint} fontFamily={THEME.mono} fontSize="9">LOW-SIDE</text>
    </svg>
  );
}

/* ============================================================================
   3D PLANT VIEW — raw three.js (r128), custom drag-orbit (no OrbitControls)
============================================================================ */
function ThreeDPlant({
  alertLevel, running, highlightComponent,
  faults, setFaultManual, pendingSP, setPendingSP, applySetpoints,
  autoOptimize, setAutoOptimize, actual,
}) {
  const mountRef = useRef(null);
  const stateRef = useRef({});
  const controlsApiRef = useRef({});
  const highlightRef = useRef(highlightComponent);
  const [autoRotate, setAutoRotate] = useState(false);
  const autoRotateRef = useRef(autoRotate);
  const [selected, setSelected] = useState(null); // "evap" | "cond" | "comp" | null
  const evapBtnRef = useRef(null);
  const condBtnRef = useRef(null);
  const compBtnRef = useRef(null);

  useEffect(() => { highlightRef.current = highlightComponent; }, [highlightComponent]);
  useEffect(() => { autoRotateRef.current = autoRotate; }, [autoRotate]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const width = mount.clientWidth, height = 380;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(THEME.bgAlt);
    scene.fog = new THREE.Fog(THEME.bgAlt, 12, 26);

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);

    // ground grid
    const grid = new THREE.GridHelper(20, 20, 0x22314a, 0x172033);
    grid.position.y = -1.6;
    group.add(grid);

    const ambient = new THREE.AmbientLight(0x8fa3c8, 0.55);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(6, 8, 5);
    scene.add(dir);
    const rim = new THREE.PointLight(0x3fd6c4, 0.6, 20);
    rim.position.set(-5, 3, -4);
    scene.add(rim);

    const matBody = new THREE.MeshStandardMaterial({ color: 0x1a2436, metalness: 0.4, roughness: 0.45 });
    const accentSpec = { color: 0x3fd6c4, metalness: 0.3, roughness: 0.3, emissive: 0x0c3532, emissiveIntensity: 0.6 };
    // Separate material per component group (not clones of a single shared object) so each
    // can be colored independently — needed both to fix live alert-color reactivity (mutating
    // a template material that's never assigned to a mesh has no visual effect) and to support
    // highlighting whichever component the diagnostic narrative names as the likely cause.
    const matAccentEvap = new THREE.MeshStandardMaterial(accentSpec);
    const matAccentCond = new THREE.MeshStandardMaterial(accentSpec);
    const matAccentComp = new THREE.MeshStandardMaterial(accentSpec);
    const matPipe = new THREE.MeshStandardMaterial({ color: 0x33445e, metalness: 0.6, roughness: 0.3 });

    // Evaporator shell (horizontal cylinder)
    const evapGeo = new THREE.CylinderGeometry(0.55, 0.55, 3.2, 24);
    const evap = new THREE.Mesh(evapGeo, matBody.clone());
    evap.rotation.z = Math.PI / 2;
    evap.position.set(-2.2, -0.3, 0);
    group.add(evap);

    // Condenser shell
    const condGeo = new THREE.CylinderGeometry(0.55, 0.55, 3.2, 24);
    const cond = new THREE.Mesh(condGeo, matBody.clone());
    cond.rotation.z = Math.PI / 2;
    cond.position.set(2.2, -0.3, 0);
    group.add(cond);

    // end caps rings (accent) to sell "shell and tube"
    [-1, 1].forEach((s) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.05, 8, 24), matAccentEvap);
      ring.rotation.y = Math.PI / 2;
      ring.position.set(-2.2 + s * 1.6, -0.3, 0);
      group.add(ring);
      const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.05, 8, 24), matAccentCond);
      ring2.rotation.y = Math.PI / 2;
      ring2.position.set(2.2 + s * 1.6, -0.3, 0);
      group.add(ring2);
    });

    // Compressor (vertical box on top, between shells)
    const compGeo = new THREE.BoxGeometry(1.1, 1.3, 1.1);
    const comp = new THREE.Mesh(compGeo, matBody.clone());
    comp.position.set(0, 0.9, 0);
    group.add(comp);
    const compTop = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 0.4, 16), matAccentComp);
    compTop.position.set(0, 1.75, 0);
    group.add(compTop);

    // base skid
    const skid = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.2, 1.6), matPipe.clone());
    skid.position.set(0, -1.55, 0);
    group.add(skid);

    // Piping connecting evap -> comp -> cond (approx paths, drawn as thin cylinders)
    function pipeBetween(a, b, mat) {
      const dir3 = new THREE.Vector3().subVectors(b, a);
      const len = dir3.length();
      const geo = new THREE.CylinderGeometry(0.06, 0.06, len, 10);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(a).addScaledVector(dir3, 0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir3.clone().normalize());
      return mesh;
    }
    const pSuction = pipeBetween(new THREE.Vector3(-2.2, 0.35, 0), new THREE.Vector3(-0.4, 0.55, 0), matPipe);
    const pDischarge = pipeBetween(new THREE.Vector3(0.4, 0.55, 0), new THREE.Vector3(2.2, 0.35, 0), matPipe);
    group.add(pSuction, pDischarge);

    // Flow particles
    const flowMatCold = new THREE.MeshBasicMaterial({ color: 0x3fd6c4 });
    const flowMatHot = new THREE.MeshBasicMaterial({ color: 0xff6a4d });
    const particles = [];
    function makeParticle(mat, path) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), mat);
      group.add(mesh);
      particles.push({ mesh, path, t: Math.random() });
    }
    const suctionPath = [new THREE.Vector3(-2.2, 0.35, 0), new THREE.Vector3(-0.4, 0.55, 0)];
    const dischargePath = [new THREE.Vector3(0.4, 0.55, 0), new THREE.Vector3(2.2, 0.35, 0)];
    for (let i = 0; i < 4; i++) makeParticle(flowMatCold, suctionPath);
    for (let i = 0; i < 4; i++) makeParticle(flowMatHot, dischargePath);

    camera.position.set(4.5, 3.2, 6.5);
    camera.lookAt(0, -0.2, 0);

    // Hotspot anchors — 3D points just above each component, projected to screen
    // space every frame so the overlay control buttons track the component as
    // the camera orbits/zooms.
    const anchors = {
      evap: new THREE.Vector3(-2.2, 0.9, 0),
      cond: new THREE.Vector3(2.2, 0.9, 0),
      comp: new THREE.Vector3(0, 2.3, 0),
    };
    const btnRefs = { evap: evapBtnRef, cond: condBtnRef, comp: compBtnRef };
    const projectToScreen = (vec3) => {
      const v = vec3.clone().project(camera);
      return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height };
    };

    // Custom drag-to-rotate (OrbitControls not available in three r128 here)
    const DEFAULT_VIEW = { rotY: 0.5, rotX: 0.12, radius: 7.6 };
    let dragging = false, lastX = 0, lastY = 0;
    let rotY = DEFAULT_VIEW.rotY, rotX = DEFAULT_VIEW.rotX, radius = DEFAULT_VIEW.radius;
    const onDown = (e) => { dragging = true; lastX = e.clientX ?? e.touches?.[0].clientX; lastY = e.clientY ?? e.touches?.[0].clientY; };
    const onUp = () => { dragging = false; };
    const onMove = (e) => {
      if (!dragging) return;
      const cx = e.clientX ?? e.touches?.[0].clientX;
      const cy = e.clientY ?? e.touches?.[0].clientY;
      rotY += (cx - lastX) * 0.008;
      rotX = Math.max(-0.3, Math.min(0.6, rotX + (cy - lastY) * 0.005));
      lastX = cx; lastY = cy;
    };
    const onWheel = (e) => {
      e.preventDefault();
      radius = Math.min(14, Math.max(4, radius + e.deltaY * 0.01));
    };
    renderer.domElement.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("mousemove", onMove);
    renderer.domElement.addEventListener("touchstart", onDown);
    window.addEventListener("touchend", onUp);
    window.addEventListener("touchmove", onMove);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    // Imperative controls exposed to the toolbar buttons in the React tree —
    // these just mutate the closured camera vars; no re-render needed.
    controlsApiRef.current = {
      zoomIn: () => { radius = Math.max(4, radius - 1.4); },
      zoomOut: () => { radius = Math.min(14, radius + 1.4); },
      reset: () => { rotY = DEFAULT_VIEW.rotY; rotX = DEFAULT_VIEW.rotX; radius = DEFAULT_VIEW.radius; },
    };

    let raf;
    const clock = new THREE.Clock();
    let pulseT = 0;
    const animate = () => {
      const dt = clock.getDelta();
      if (autoRotateRef.current && !dragging) rotY += dt * 0.25;
      camera.position.x = Math.sin(rotY) * radius;
      camera.position.z = Math.cos(rotY) * radius;
      camera.position.y = 2 + rotX * radius;
      camera.lookAt(0, -0.2, 0);

      if (running) {
        particles.forEach((p) => {
          p.t += dt * 0.5;
          if (p.t > 1) p.t = 0;
          p.mesh.position.lerpVectors(p.path[0], p.path[1], p.t);
        });
        compTop.rotation.y += dt * 2.2;
      }

      pulseT += dt;
      const alertColor = alertLevel === "critical" ? 0xef4b52 : alertLevel === "warning" ? 0xf2a93b : 0x3fd6c4;
      const pulse = 0.6 + Math.sin(pulseT * 4) * 0.35; // 0.25–0.95, for the highlighted component
      [["evap", matAccentEvap], ["cond", matAccentCond], ["comp", matAccentComp]].forEach(([key, mat]) => {
        mat.emissive.set(alertColor);
        mat.emissiveIntensity = highlightRef.current === key ? pulse : 0.6;
      });
      rim.color.set(alertColor);

      for (const key of Object.keys(anchors)) {
        const pos = projectToScreen(anchors[key]);
        const el = btnRefs[key].current;
        if (el) el.style.transform = `translate(-50%, -50%) translate(${pos.x}px, ${pos.y}px)`;
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    stateRef.current = { renderer, mount };

    return () => {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mousemove", onMove);
      renderer.domElement.removeEventListener("touchstart", onDown);
      window.removeEventListener("touchend", onUp);
      window.removeEventListener("touchmove", onMove);
      renderer.domElement.removeEventListener("wheel", onWheel);
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, [alertLevel, running]);

  const btnStyle = (active) => ({
    padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontFamily: THEME.mono, fontSize: 10,
    background: active ? `${THEME.cyan}22` : THEME.panel2, border: `1px solid ${active ? THEME.cyan : THEME.border}`,
    color: active ? THEME.cyan : THEME.textDim, display: "flex", alignItems: "center", gap: 5,
  });

  const hotspotStyle = (key) => ({
    position: "absolute", top: 0, left: 0, width: 30, height: 30, borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0,
    background: selected === key ? THEME.cyan : highlightComponent === key ? `${THEME.red}44` : "rgba(14,21,33,0.85)",
    border: `2px solid ${selected === key ? THEME.cyan : highlightComponent === key ? THEME.red : THEME.borderLit}`,
    color: selected === key ? "#04211d" : highlightComponent === key ? THEME.red : THEME.text,
    boxShadow: highlightComponent === key ? `0 0 10px ${THEME.red}88` : "0 2px 6px rgba(0,0,0,0.4)",
    zIndex: 5,
  });

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <button onClick={() => controlsApiRef.current.zoomIn?.()} style={btnStyle(false)}>
          <ZoomIn size={12} /> Zoom In
        </button>
        <button onClick={() => controlsApiRef.current.zoomOut?.()} style={btnStyle(false)}>
          <ZoomOut size={12} /> Zoom Out
        </button>
        <button onClick={() => controlsApiRef.current.reset?.()} style={btnStyle(false)}>
          <RotateCcw size={12} /> Reset View
        </button>
        <button onClick={() => setAutoRotate((r) => !r)} style={btnStyle(autoRotate)}>
          <RotateCw size={12} /> Auto-Rotate
        </button>
      </div>
      <div style={{ position: "relative" }}>
        <div ref={mountRef} style={{ width: "100%", height: 380, borderRadius: 8, overflow: "hidden", border: `1px solid ${THEME.border}` }} />
        <button ref={evapBtnRef} title="Evaporator controls" style={hotspotStyle("evap")}
          onClick={() => setSelected((s) => (s === "evap" ? null : "evap"))}>
          <Droplets size={14} />
        </button>
        <button ref={condBtnRef} title="Condenser controls" style={hotspotStyle("cond")}
          onClick={() => setSelected((s) => (s === "cond" ? null : "cond"))}>
          <Flame size={14} />
        </button>
        <button ref={compBtnRef} title="Compressor controls" style={hotspotStyle("comp")}
          onClick={() => setSelected((s) => (s === "comp" ? null : "comp"))}>
          <Zap size={14} />
        </button>
      </div>
      <p style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint, marginTop: 8 }}>
        Drag to orbit · Scroll to zoom · Click a component badge to control it · Cyan = suction flow ·
        Orange = discharge flow{highlightComponent ? " · pulsing/red badge marks the likely fault source" : ""}
      </p>

      {selected && (
        <div onMouseDown={(e) => e.stopPropagation()} style={{
          marginTop: 10, padding: 14, background: THEME.panel2, border: `1px solid ${THEME.borderLit}`, borderRadius: 8,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontFamily: THEME.mono, fontSize: 11, color: THEME.text, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {selected === "evap" ? "Evaporator Controls" : selected === "cond" ? "Condenser Controls" : "Compressor Controls"}
            </span>
            <button onClick={() => setSelected(null)} style={{ background: "transparent", border: "none", color: THEME.textDim, cursor: "pointer", padding: 0 }}>
              <XCircle size={15} />
            </button>
          </div>

          {selected === "evap" && (
            <>
              <Slider label="Evaporator Fouling" value={faults.evapFouling} min={0} max={100} step={1} unit="%" color={THEME.amber}
                onChange={(v) => setFaultManual("evapFouling", v)} />
              <Slider label="Refrigerant Charge Loss" value={faults.refrigerantLoss} min={0} max={100} step={1} unit="%" color={THEME.red}
                onChange={(v) => setFaultManual("refrigerantLoss", v)} />
              <Slider label="Chilled Water Supply SP" value={pendingSP.chw} min={4} max={10} step={0.1} unit="°C" color={THEME.cyan}
                onChange={(v) => setPendingSP((sp) => ({ ...sp, chw: v }))} />
            </>
          )}

          {selected === "cond" && (
            <>
              <Slider label="Condenser Fouling" value={faults.condFouling} min={0} max={100} step={1} unit="%" color={THEME.amber}
                onChange={(v) => setFaultManual("condFouling", v)} />
              <Slider label="Condenser Water Entering SP" value={pendingSP.cw} min={24} max={32} step={0.1} unit="°C" color={THEME.hot}
                onChange={(v) => setPendingSP((sp) => ({ ...sp, cw: v }))} />
            </>
          )}

          {selected === "comp" && (
            <>
              <Slider label="Compressor Wear" value={faults.compressorWear} min={0} max={100} step={1} unit="%" color={THEME.red}
                onChange={(v) => setFaultManual("compressorWear", v)} />
              <div style={{ display: "flex", gap: 24, marginBottom: 12 }}>
                <StatPill label="Power Draw" value={actual.compressorPowerKW.toFixed(0)} unit="kW" />
                <StatPill label="COP" value={actual.cop.toFixed(2)} unit="—" />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: THEME.mono, fontSize: 11, color: THEME.textDim }}>
                <input type="checkbox" checked={autoOptimize} onChange={(e) => setAutoOptimize(e.target.checked)} />
                Enable auto chilled-water-reset optimization
              </label>
            </>
          )}

          {(selected === "evap" || selected === "cond") && (
            <button onClick={applySetpoints} style={{
              width: "100%", padding: "9px", background: THEME.cyan, color: "#04211d", border: "none", borderRadius: 6,
              fontFamily: THEME.mono, fontSize: 11, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 4,
            }}>
              <Send size={13} /> SEND COMMAND TO BMS
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
   MAIN APP
============================================================================ */
const HISTORY_LEN = 40;
const MAX_LOG = 30;
const MAX_ALERTS = 25;

/* ============================================================================
   FLEET CONFIG — one entry per chiller in the plant. Different baselines/tons
   per unit so the fleet feels like real, non-identical equipment rather than
   three clones.
============================================================================ */
const CHILLERS = [
  {
    id: "CH-01", name: "CH-01", type: "500-TON CENTRIFUGAL", tons: 500,
    baseline: { evapApproachBase: 1.5, condApproachBase: 2.0, eta2ndBase: 0.45 },
    initialFaults: { evapFouling: 6, condFouling: 8, refrigerantLoss: 3, compressorWear: 5 },
    initialLoad: 68, initialSP: { chw: 6.7, cw: 29.4 },
  },
  {
    id: "CH-02", name: "CH-02", type: "350-TON SCREW", tons: 350,
    baseline: { evapApproachBase: 1.8, condApproachBase: 2.2, eta2ndBase: 0.42 },
    initialFaults: { evapFouling: 4, condFouling: 5, refrigerantLoss: 2, compressorWear: 3 },
    initialLoad: 55, initialSP: { chw: 6.7, cw: 29.0 },
  },
  {
    id: "CH-03", name: "CH-03", type: "300-TON SCREW (AGING)", tons: 300,
    baseline: { evapApproachBase: 2.2, condApproachBase: 2.8, eta2ndBase: 0.38 },
    initialFaults: { evapFouling: 18, condFouling: 22, refrigerantLoss: 9, compressorWear: 15 },
    initialLoad: 72, initialSP: { chw: 6.9, cw: 29.8 },
  },
];

/* ============================================================================
   GUIDED DEMO SCENARIOS
   Each scenario ramps the existing fault sliders toward a target over time —
   the existing alert/deviation engine reacts on its own, no separate logic
   needed. Narration beats are keyed by progress fraction (0-1).
============================================================================ */
const DEMO_SCENARIOS = {
  refrigerantLeak: {
    label: "Refrigerant Leak",
    duration: 24000,
    target: { evapFouling: 10, condFouling: 10, refrigerantLoss: 65, compressorWear: 8 },
    narration: [
      { at: 0.00, text: "Simulating a slow refrigerant leak…" },
      { at: 0.30, text: "Evaporator approach widening as charge drops…" },
      { at: 0.60, text: "Efficiency deviation crossing the warning threshold…" },
      { at: 0.85, text: "Critical alert — refrigerant charge loss confirmed." },
    ],
  },
  condenserFouling: {
    label: "Condenser Fouling",
    duration: 22000,
    target: { evapFouling: 8, condFouling: 75, refrigerantLoss: 5, compressorWear: 8 },
    narration: [
      { at: 0.00, text: "Simulating scale buildup on the condenser tubes…" },
      { at: 0.30, text: "Condenser approach temperature widening…" },
      { at: 0.60, text: "kW/ton drifting above the digital-twin baseline…" },
      { at: 0.85, text: "Warning alert — possible condenser tube fouling." },
    ],
  },
  compressorWear: {
    label: "Compressor Wear",
    duration: 22000,
    target: { evapFouling: 8, condFouling: 8, refrigerantLoss: 5, compressorWear: 70 },
    narration: [
      { at: 0.00, text: "Simulating bearing/valve wear on the compressor…" },
      { at: 0.30, text: "Second-law efficiency (η₂ₙᵈ) starting to drop…" },
      { at: 0.60, text: "COP falling, compressor power climbing…" },
      { at: 0.85, text: "Critical alert — schedule bearing/valve inspection." },
    ],
  },
};

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/* ============================================================================
   PER-CHILLER SIMULATION MODEL
   Encapsulates everything about one chiller — faults, setpoints, history,
   alerts, demo scenarios, alarm — so the fleet is just N independent
   instances of this hook, each ticking off the same shared clock (`tick`,
   `running`) and the same shared utility rate (`electricityRate`). Called
   explicitly once per chiller in App (not in a loop/map) to keep hook calls
   unconditional and in a fixed order, per the Rules of Hooks.
============================================================================ */
function useChillerModel(config, { tick, running, electricityRate }) {
  const [autoOptimize, setAutoOptimize] = useState(false);
  const [loadPct, setLoadPct] = useState(config.initialLoad);
  const [confirmedSP, setConfirmedSP] = useState(config.initialSP);
  const [pendingSP, setPendingSP] = useState(config.initialSP);
  const [faults, setFaults] = useState(config.initialFaults);
  const [history, setHistory] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [commandLog, setCommandLog] = useState([]);
  const [pendingCommands, setPendingCommands] = useState(0);

  // Guided demo (client-facing scripted fault scenarios)
  const [demo, setDemo] = useState({ scenarioId: null, active: false, progress: 0, narration: "" });
  const preDemoFaultsRef = useRef(null);
  const demoIntervalRef = useRef(null);
  const demoStartFaultsRef = useRef(null);

  const baseline = config.baseline;

  const pushAlert = useCallback((severity, message, tag) => {
    setAlerts((prev) => {
      const last = prev[0];
      if (last && last.message === message && Date.now() - last.tsRaw < 15000) return prev; // debounce dupes
      const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, severity, message, tag, tsRaw: Date.now(), ts: new Date().toLocaleTimeString() };
      return [entry, ...prev].slice(0, MAX_ALERTS);
    });
  }, []);

  const sendCommand = useCallback((point, value, unit) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setCommandLog((prev) => [{ id, ts: new Date().toLocaleTimeString(), point, value, unit, status: "SENT" }, ...prev].slice(0, MAX_LOG));
    setPendingCommands((n) => n + 1);
    setTimeout(() => {
      setCommandLog((prev) => prev.map((c) => (c.id === id ? { ...c, status: "ACKED" } : c)));
      setPendingCommands((n) => Math.max(0, n - 1));
      if (point === `${config.id}.CHW_SP`) setConfirmedSP((sp) => ({ ...sp, chw: value }));
      if (point === `${config.id}.CW_SP`) setConfirmedSP((sp) => ({ ...sp, cw: value }));
    }, 1100 + Math.random() * 500);
  }, [config.id]);

  const applySetpoints = () => {
    if (pendingSP.chw !== confirmedSP.chw) sendCommand(`${config.id}.CHW_SP`, pendingSP.chw, "°C");
    if (pendingSP.cw !== confirmedSP.cw) sendCommand(`${config.id}.CW_SP`, pendingSP.cw, "°C");
  };

  const stopDemo = useCallback(() => {
    if (demoIntervalRef.current) {
      clearInterval(demoIntervalRef.current);
      demoIntervalRef.current = null;
    }
    setDemo((d) => ({ ...d, active: false }));
  }, []);

  const startDemo = useCallback((scenarioId) => {
    const scenario = DEMO_SCENARIOS[scenarioId];
    if (!scenario) return;
    if (demoIntervalRef.current) clearInterval(demoIntervalRef.current);

    if (!preDemoFaultsRef.current) preDemoFaultsRef.current = faults;
    demoStartFaultsRef.current = faults;

    const startedAt = Date.now();
    setDemo({ scenarioId, active: true, progress: 0, narration: scenario.narration[0]?.text || "" });

    demoIntervalRef.current = setInterval(() => {
      const rawT = Math.min(1, (Date.now() - startedAt) / scenario.duration);
      const t = smoothstep(rawT);
      const from = demoStartFaultsRef.current;
      setFaults(() => {
        const next = {};
        for (const key of Object.keys(scenario.target)) {
          next[key] = Math.round(from[key] + (scenario.target[key] - from[key]) * t);
        }
        return next;
      });

      let narration = scenario.narration[0]?.text || "";
      for (const beat of scenario.narration) if (rawT >= beat.at) narration = beat.text;
      setDemo((d) => ({ ...d, progress: rawT, narration }));

      if (rawT >= 1) {
        clearInterval(demoIntervalRef.current);
        demoIntervalRef.current = null;
        setDemo((d) => ({ ...d, active: false }));
      }
    }, 200);
  }, [faults]);

  const resetDemo = useCallback(() => {
    stopDemo();
    if (preDemoFaultsRef.current) {
      setFaults(preDemoFaultsRef.current);
      preDemoFaultsRef.current = null;
    }
    setDemo({ scenarioId: null, active: false, progress: 0, narration: "" });
  }, [stopDemo]);

  // Manual fault-slider interaction always wins over an in-progress demo
  const setFaultManual = useCallback((key, value) => {
    if (demoIntervalRef.current) stopDemo();
    setFaults((f) => ({ ...f, [key]: value }));
  }, [stopDemo]);

  useEffect(() => {
    return () => { if (demoIntervalRef.current) clearInterval(demoIntervalRef.current); };
  }, []);

  useEffect(() => {
    // gentle random-walk on load to feel alive
    setLoadPct((l) => Math.min(95, Math.max(20, l + (Math.random() - 0.5) * 6)));
  }, [tick]);

  const twin = useMemo(() => computeCyclePerformance({
    chwLeavingSP: confirmedSP.chw, cwEnteringSP: confirmedSP.cw, loadPct, designTons: config.tons,
    evapFouling: 0, condFouling: 0, refrigerantLoss: 0, compressorWear: 0, noise: 0,
    ...baseline,
  }), [confirmedSP, loadPct, config.tons, baseline]);

  const actual = useMemo(() => computeCyclePerformance({
    chwLeavingSP: confirmedSP.chw, cwEnteringSP: confirmedSP.cw, loadPct, designTons: config.tons,
    ...faults, noise: (Math.random() - 0.5) * 0.25,
    ...baseline,
  }), [confirmedSP, loadPct, faults, tick, config.tons, baseline]);

  const deviationPct = twin.kwPerTon > 0 ? ((actual.kwPerTon - twin.kwPerTon) / twin.kwPerTon) * 100 : 0;
  const alertLevel = deviationPct > 18 ? "critical" : deviationPct > 8 ? "warning" : "ok";

  // Cost impact — translates the kW/ton deviation into $ terms, assuming continuous operation
  // at the current excess draw. Illustrative, like the rest of this prototype's numbers.
  const costImpact = useMemo(() => {
    const excessKwPerTon = Math.max(0, actual.kwPerTon - twin.kwPerTon);
    const excessPowerKW = excessKwPerTon * actual.coolingLoadTons;
    const perHour = excessPowerKW * electricityRate;
    const perDay = perHour * 24;
    return { excessPowerKW, perHour, perDay, perMonth: perDay * 30, perYear: perDay * 365 };
  }, [actual.kwPerTon, twin.kwPerTon, actual.coolingLoadTons, electricityRate]);

  // Diagnostic narrative — isolate each fault (others zeroed) through the same
  // physics function to find which one is driving the most deviation, so the
  // narrative names an actual likely cause instead of guessing from raw slider values.
  const dominantCauseKey = useMemo(() => {
    if (twin.kwPerTon <= 0) return null;
    let best = null;
    for (const key of Object.keys(FAULT_CAUSES)) {
      const isolated = computeCyclePerformance({
        chwLeavingSP: confirmedSP.chw, cwEnteringSP: confirmedSP.cw, loadPct, designTons: config.tons,
        evapFouling: 0, condFouling: 0, refrigerantLoss: 0, compressorWear: 0, noise: 0,
        [key]: faults[key], ...baseline,
      });
      const dev = ((isolated.kwPerTon - twin.kwPerTon) / twin.kwPerTon) * 100;
      if (!best || dev > best.dev) best = { key, dev };
    }
    return best && best.dev > 1 ? best.key : null;
  }, [faults, confirmedSP, loadPct, twin.kwPerTon, config.tons, baseline]);

  // Predictive forecast — linear trend fit over recent history, projected
  // forward to a time-to-threshold estimate (see computeForecast doc comment).
  const forecast = useMemo(() => computeForecast(history, deviationPct), [history, deviationPct]);

  const narrative = useMemo(() => buildDiagnosticNarrative({
    chillerName: config.name, alertLevel, deviationPct, dominantCauseKey, actual, baseline, costImpact, forecast,
  }), [config.name, alertLevel, deviationPct, dominantCauseKey, actual, costImpact, forecast]);

  // Maps a fault cause onto which physical component to highlight in the 3D view.
  const highlightComponent =
    dominantCauseKey === "condFouling" ? "cond"
    : dominantCauseKey === "compressorWear" ? "comp"
    : (dominantCauseKey === "evapFouling" || dominantCauseKey === "refrigerantLoss") ? "evap"
    : null;

  // Alarm moment — a transient siren banner + tone fired once, the instant plant
  // status transitions INTO critical (not on every render while it stays critical).
  const [alarmActive, setAlarmActive] = useState(false);
  const [alarmMessage, setAlarmMessage] = useState("");
  const prevAlertLevelRef = useRef(alertLevel);
  useEffect(() => {
    if (alertLevel === "critical" && prevAlertLevelRef.current !== "critical") {
      setAlarmMessage(narrative.headline);
      setAlarmActive(true);
      playAlarmTone();
      const t = setTimeout(() => setAlarmActive(false), 7000);
      prevAlertLevelRef.current = alertLevel;
      return () => clearTimeout(t);
    }
    prevAlertLevelRef.current = alertLevel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertLevel]);

  // history + alert generation
  useEffect(() => {
    if (tick === 0) return;
    setHistory((prev) => [...prev, {
      t: tick, time: new Date().toLocaleTimeString().slice(0, 5),
      twinKw: Number(twin.kwPerTon.toFixed(3)), actualKw: Number(actual.kwPerTon.toFixed(3)),
      cop: Number(actual.cop.toFixed(2)), load: Number(loadPct.toFixed(0)),
      evapApproach: Number(actual.evapApproach.toFixed(2)), condApproach: Number(actual.condApproach.toFixed(2)),
    }].slice(-HISTORY_LEN));

    if (deviationPct > 18) pushAlert("critical", `Actual kW/ton is ${deviationPct.toFixed(0)}% above digital-twin baseline — investigate immediately`, "PERF");
    else if (deviationPct > 8) pushAlert("warning", `Efficiency drifting: kW/ton ${deviationPct.toFixed(0)}% above expected baseline`, "PERF");

    if (actual.condApproach - baseline.condApproachBase > 3) pushAlert("warning", `Condenser approach ${actual.condApproach.toFixed(1)}°C — possible tube fouling`, "COND");
    if (actual.evapApproach - baseline.evapApproachBase > 3) pushAlert("warning", `Evaporator approach ${actual.evapApproach.toFixed(1)}°C — possible fouling or low charge`, "EVAP");
    if (faults.refrigerantLoss > 55) pushAlert("critical", `Refrigerant charge deviation severe (${faults.refrigerantLoss}%) — check for leak`, "CHG");
    if (faults.compressorWear > 60) pushAlert("critical", `Compressor efficiency loss ${faults.compressorWear}% — schedule bearing/valve inspection`, "COMP");

    if (autoOptimize) {
      const rec = recommendChwSetpoint(loadPct, confirmedSP.chw);
      if (Math.abs(rec.target - confirmedSP.chw) > 0.3 && pendingCommands === 0) {
        pushAlert("info", `Auto-optimize: resetting CHW setpoint to ${rec.target}°C for current ${loadPct.toFixed(0)}% load`, "OPT");
        sendCommand(`${config.id}.CHW_SP`, rec.target, "°C");
        setPendingSP((sp) => ({ ...sp, chw: rec.target }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  return {
    id: config.id, name: config.name, type: config.type, tons: config.tons, baseline,
    loadPct, confirmedSP, pendingSP, setPendingSP, faults, setFaultManual, applySetpoints,
    autoOptimize, setAutoOptimize, history, alerts, commandLog, pendingCommands,
    demo, startDemo, stopDemo, resetDemo, preDemoFaultsRef,
    twin, actual, deviationPct, alertLevel, costImpact, dominantCauseKey, narrative, highlightComponent,
    alarmActive, setAlarmActive, alarmMessage, forecast,
  };
}

function FleetOverview({ chillers, onSelect }) {
  const totalTons = chillers.reduce((s, c) => s + c.tons, 0);
  const totalMonthlyCost = chillers.reduce((s, c) => s + c.costImpact.perMonth, 0);
  const totalAlerts = chillers.reduce((s, c) => s + c.alerts.filter((a) => a.severity !== "info").length, 0);
  const worstLevel = chillers.some((c) => c.alertLevel === "critical") ? "critical"
    : chillers.some((c) => c.alertLevel === "warning") ? "warning" : "ok";

  return (
    <div>
      <div style={{ display: "flex", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
        <Panel style={{ flex: "1 1 140px" }}><StatPill label="Plant Capacity" value={totalTons} unit="tons" /></Panel>
        <Panel style={{ flex: "1 1 140px" }}><StatPill label="Chillers" value={chillers.length} unit="units" /></Panel>
        <Panel style={{ flex: "1 1 140px" }}><StatPill label="Fleet Excess Cost" value={formatUSD(totalMonthlyCost)} unit="/mo" color={severityColor(worstLevel)} /></Panel>
        <Panel style={{ flex: "1 1 140px" }}><StatPill label="Active Alerts" value={totalAlerts} unit="" color={totalAlerts ? THEME.amber : THEME.textDim} /></Panel>
        <Panel style={{ flex: "1 1 140px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {worstLevel === "critical" ? <AlertOctagon size={20} color={THEME.red} /> : worstLevel === "warning" ? <AlertTriangle size={20} color={THEME.amber} /> : <CheckCircle2 size={20} color={THEME.green} />}
            <div>
              <div style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint }}>FLEET STATUS</div>
              <SeverityBadge severity={worstLevel} />
            </div>
          </div>
        </Panel>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
        {chillers.map((c) => (
          <Panel key={c.id} title={c.name} icon={Snowflake} right={<SeverityBadge severity={c.alertLevel} />}>
            <div onClick={() => onSelect(c.id)} style={{ cursor: "pointer" }}>
              <div style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint, marginBottom: 12 }}>{c.type}</div>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 12 }}>
                <StatPill label="kW/ton" value={c.actual.kwPerTon.toFixed(3)} unit="" color={severityColor(c.alertLevel)} />
                <StatPill label="Deviation" value={(c.deviationPct >= 0 ? "+" : "") + c.deviationPct.toFixed(1)} unit="%" color={severityColor(c.alertLevel)} />
                <StatPill label="Cost Impact" value={formatUSD(c.costImpact.perMonth)} unit="/mo" color={c.costImpact.perMonth > 10 ? THEME.amber : THEME.textDim} />
              </div>
              <p style={{ fontSize: 12, color: THEME.textDim, margin: 0, lineHeight: 1.4 }}>{c.narrative.headline}</p>
              {c.forecast?.ready && c.forecast.direction === "worsening" && c.alertLevel !== "critical" && (c.forecast.hoursToCritical != null || c.forecast.hoursToWarning != null) && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 11, color: THEME.amber }}>
                  <TrendingUp size={12} />
                  <span>
                    Trending to {c.forecast.hoursToCritical != null ? "critical" : "warning"} in{" "}
                    {formatForecastTime(c.forecast.hoursToCritical ?? c.forecast.hoursToWarning)}
                  </span>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, paddingTop: 10, borderTop: `1px solid ${THEME.border}` }}>
                <span style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint }}>
                  {c.alerts.filter((a) => a.severity !== "info").length} active alert(s)
                </span>
                <span style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.cyan, display: "flex", alignItems: "center", gap: 3 }}>
                  Manage <ChevronRight size={12} />
                </span>
              </div>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

function ChillerDetailView({ chiller, tab, running, electricityRate, setElectricityRate }) {
  const {
    confirmedSP, pendingSP, setPendingSP, faults, setFaultManual, applySetpoints,
    autoOptimize, setAutoOptimize, history, alerts, commandLog, pendingCommands,
    demo, startDemo, stopDemo, resetDemo, preDemoFaultsRef,
    twin, actual, deviationPct, alertLevel, costImpact, narrative, highlightComponent,
    loadPct, baseline, forecast,
  } = chiller;

  return (
    <>
        {(demo.active || demo.progress > 0) && (
          <div style={{
            display: "flex", alignItems: "center", gap: 12, marginBottom: 14, padding: "10px 14px",
            background: `${THEME.cyan}10`, border: `1px solid ${THEME.cyan}44`, borderRadius: 8,
          }}>
            {demo.active ? <Play size={14} color={THEME.cyan} /> : <CheckCircle2 size={14} color={THEME.cyan} />}
            <span style={{ fontFamily: THEME.mono, fontSize: 9, color: THEME.textFaint, whiteSpace: "nowrap" }}>
              DEMO: {DEMO_SCENARIOS[demo.scenarioId]?.label?.toUpperCase()}
            </span>
            <div style={{ flex: 1, height: 4, background: THEME.panel2, borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${demo.progress * 100}%`, background: THEME.cyan, transition: "width 0.2s linear" }} />
            </div>
            <span style={{ fontSize: 12, color: THEME.text, flexShrink: 0, maxWidth: "40%" }}>{demo.narration}</span>
            {demo.active && (
              <button onClick={stopDemo} style={{
                background: "transparent", border: `1px solid ${THEME.border}`, borderRadius: 5,
                color: THEME.textDim, fontFamily: THEME.mono, fontSize: 10, padding: "4px 8px", cursor: "pointer",
                display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
              }}>
                <Square size={10} /> Stop
              </button>
            )}
          </div>
        )}
        {/* Top status bar */}
        <div style={{ display: "flex", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
          <Panel style={{ flex: "1 1 140px" }}><StatPill label="Cooling Load" value={actual.coolingLoadTons.toFixed(0)} unit="tons" /></Panel>
          <Panel style={{ flex: "1 1 140px" }}><StatPill label="Actual kW/ton" value={actual.kwPerTon.toFixed(3)} unit="kW/ton" color={alertLevel === "critical" ? THEME.red : alertLevel === "warning" ? THEME.amber : THEME.green} /></Panel>
          <Panel style={{ flex: "1 1 140px" }}><StatPill label="Twin Baseline" value={twin.kwPerTon.toFixed(3)} unit="kW/ton" color={THEME.cyan} /></Panel>
          <Panel style={{ flex: "1 1 140px" }}><StatPill label="Deviation" value={(deviationPct >= 0 ? "+" : "") + deviationPct.toFixed(1)} unit="%" color={alertLevel === "critical" ? THEME.red : alertLevel === "warning" ? THEME.amber : THEME.green} /></Panel>
          <Panel style={{ flex: "1 1 140px" }}><StatPill label="COP (actual)" value={actual.cop.toFixed(2)} unit="—" /></Panel>
          <Panel style={{ flex: "1 1 140px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {alertLevel === "critical" ? <AlertOctagon size={20} color={THEME.red} /> : alertLevel === "warning" ? <AlertTriangle size={20} color={THEME.amber} /> : <CheckCircle2 size={20} color={THEME.green} />}
              <div>
                <div style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint }}>PLANT STATUS</div>
                <SeverityBadge severity={alertLevel} />
              </div>
            </div>
          </Panel>
        </div>

        {tab === "overview" && (
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}>
            <Panel title="Diagnostic Summary" icon={Sparkles} style={{ gridColumn: "span 2" }}>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                {alertLevel === "critical" ? <AlertOctagon size={18} color={THEME.red} style={{ flexShrink: 0, marginTop: 2 }} />
                  : alertLevel === "warning" ? <AlertTriangle size={18} color={THEME.amber} style={{ flexShrink: 0, marginTop: 2 }} />
                  : <CheckCircle2 size={18} color={THEME.green} style={{ flexShrink: 0, marginTop: 2 }} />}
                <div>
                  <p style={{ fontSize: 14, fontWeight: 600, margin: 0, marginBottom: 4 }}>{narrative.headline}</p>
                  <p style={{ fontSize: 12, color: THEME.textDim, margin: 0 }}>{narrative.detail}</p>
                </div>
              </div>
            </Panel>
            <Panel title="Refrigeration Cycle — Live Schematic" icon={Activity}>
              <Schematic2D Tevap={actual.Tevap} Tcond={actual.Tcond} running={running} alertLevel={alertLevel} />
            </Panel>
            <Panel title="Live Gauges" icon={Wind}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <GaugeMeter label="kW/ton" value={actual.kwPerTon} min={0.3} max={1.3} unit="kW/t" zones={[{ from: 0, color: THEME.green }, { from: 0.75, color: THEME.amber }, { from: 0.95, color: THEME.red }]} />
                <GaugeMeter label="Load" value={loadPct} min={0} max={100} unit="%" decimals={0} zones={[{ from: 0, color: THEME.cyan }]} />
                <GaugeMeter label="Evap ΔT-app" value={actual.evapApproach} min={0} max={8} unit="°C" zones={[{ from: 0, color: THEME.green }, { from: 3, color: THEME.amber }, { from: 5, color: THEME.red }]} />
                <GaugeMeter label="Cond ΔT-app" value={actual.condApproach} min={0} max={9} unit="°C" zones={[{ from: 0, color: THEME.green }, { from: 4, color: THEME.amber }, { from: 6.5, color: THEME.red }]} />
              </div>
            </Panel>
            <Panel title="Cost Impact of Inefficiency" icon={DollarSign} style={{ gridColumn: "span 2" }}>
              <div style={{ display: "flex", gap: 30, flexWrap: "wrap", marginBottom: 14 }}>
                <StatPill label="Excess Power Draw" value={costImpact.excessPowerKW.toFixed(0)} unit="kW"
                  color={alertLevel === "critical" ? THEME.red : alertLevel === "warning" ? THEME.amber : THEME.green} />
                <StatPill label="Cost / Day" value={formatUSD(costImpact.perDay)} unit=""
                  color={alertLevel === "critical" ? THEME.red : alertLevel === "warning" ? THEME.amber : THEME.green} />
                <StatPill label="Cost / Month" value={formatUSD(costImpact.perMonth)} unit=""
                  color={alertLevel === "critical" ? THEME.red : alertLevel === "warning" ? THEME.amber : THEME.green} />
                <StatPill label="Cost / Year (projected)" value={formatUSD(costImpact.perYear)} unit="" color={THEME.red} />
              </div>
              <div style={{ maxWidth: 320 }}>
                <Slider label="Electricity Rate" value={electricityRate} min={0.05} max={0.40} step={0.01}
                  decimals={2} unit=" $/kWh" color={THEME.green} onChange={setElectricityRate} />
              </div>
              <p style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint }}>
                {costImpact.excessPowerKW > 0.5
                  ? "Estimated at the current deviation and load, assuming continuous operation. Illustrative — not a substitute for a metered energy audit."
                  : "Operating at or better than the digital-twin baseline right now — no excess energy cost."}
              </p>
            </Panel>
            <Panel title="Setpoints (Confirmed on Device)" icon={Settings2} style={{ gridColumn: "span 2" }}>
              <div style={{ display: "flex", gap: 30, flexWrap: "wrap" }}>
                <StatPill label="CHW Supply SP" value={confirmedSP.chw.toFixed(1)} unit="°C" color={THEME.cyan} />
                <StatPill label="Condenser Water SP" value={confirmedSP.cw.toFixed(1)} unit="°C" color={THEME.hot} />
                <StatPill label="Compressor Power" value={actual.compressorPowerKW.toFixed(0)} unit="kW" />
                <StatPill label="Pending Commands" value={pendingCommands} unit="" color={pendingCommands ? THEME.amber : THEME.textDim} />
              </div>
            </Panel>
          </div>
        )}

        {tab === "twin" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Panel title="Digital Twin (Expected — Healthy Baseline)" icon={Activity}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <StatPill label="Evaporating Temp" value={twin.Tevap.toFixed(2)} unit="°C" color={THEME.cyan} />
                <StatPill label="Condensing Temp" value={twin.Tcond.toFixed(2)} unit="°C" color={THEME.hot} />
                <StatPill label="Carnot COP" value={twin.copCarnot.toFixed(2)} unit="—" />
                <StatPill label="COP (η₂ₙ𝒹 = 0.45)" value={twin.cop.toFixed(2)} unit="—" color={THEME.green} />
                <StatPill label="kW/ton" value={twin.kwPerTon.toFixed(3)} unit="kW/ton" color={THEME.green} />
              </div>
            </Panel>
            <Panel title="Physical Plant (Actual — With Injected Faults)" icon={Wrench}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <StatPill label="Evaporating Temp" value={actual.Tevap.toFixed(2)} unit="°C" color={THEME.cyan} />
                <StatPill label="Condensing Temp" value={actual.Tcond.toFixed(2)} unit="°C" color={THEME.hot} />
                <StatPill label="Carnot COP" value={actual.copCarnot.toFixed(2)} unit="—" />
                <StatPill label={`COP (η₂ₙ𝒹 = ${actual.eta2nd.toFixed(2)})`} value={actual.cop.toFixed(2)} unit="—" color={alertLevel === "ok" ? THEME.green : alertLevel === "warning" ? THEME.amber : THEME.red} />
                <StatPill label="kW/ton" value={actual.kwPerTon.toFixed(3)} unit="kW/ton" color={alertLevel === "ok" ? THEME.green : alertLevel === "warning" ? THEME.amber : THEME.red} />
              </div>
            </Panel>
            <Panel title="Twin vs Actual — kW/ton" icon={TrendingUp} style={{ gridColumn: "span 2" }}>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={history}>
                  <CartesianGrid stroke={THEME.border} strokeDasharray="3 3" />
                  <XAxis dataKey="time" stroke={THEME.textFaint} fontSize={10} />
                  <YAxis stroke={THEME.textFaint} fontSize={10} domain={["auto", "auto"]} />
                  <Tooltip contentStyle={{ background: THEME.panel2, border: `1px solid ${THEME.border}`, fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="twinKw" name="Twin (expected)" stroke={THEME.green} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="actualKw" name="Actual (measured)" stroke={THEME.red} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </Panel>
          </div>
        )}

        {tab === "trends" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Panel title="Predictive Forecast" icon={TrendingUp} style={{ gridColumn: "span 2" }}>
              {!forecast.ready ? (
                <p style={{ fontSize: 12, color: THEME.textDim, margin: 0 }}>
                  Gathering trend data — forecast available after a few more telemetry samples.
                </p>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 30, flexWrap: "wrap", marginBottom: 12 }}>
                    <StatPill label="Trend"
                      value={forecast.direction === "worsening" ? "▲ Worsening" : forecast.direction === "improving" ? "▼ Improving" : "▬ Stable"}
                      unit="" color={forecast.direction === "worsening" ? THEME.red : forecast.direction === "improving" ? THEME.green : THEME.textDim} />
                    <StatPill label="Drift Rate" value={(forecast.slope >= 0 ? "+" : "") + forecast.slope.toFixed(2)} unit="%/hr" />
                    {forecast.hoursToWarning != null && (
                      <StatPill label="Time to Warning" value={formatForecastTime(forecast.hoursToWarning)} unit="" color={THEME.amber} />
                    )}
                    {forecast.hoursToCritical != null && (
                      <StatPill label="Time to Critical" value={formatForecastTime(forecast.hoursToCritical)} unit="" color={THEME.red} />
                    )}
                  </div>
                  <p style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint, margin: 0 }}>
                    Linear trend fit to the last {Math.min(history.length, FORECAST_WINDOW)} telemetry samples (each
                    sample ≈ 1 hour of real operation, illustrative). Not a substitute for a proper degradation model.
                  </p>
                </>
              )}
            </Panel>
            <Panel title="COP & Load" icon={TrendingUp}>
              <ResponsiveContainer width="100%" height={230}>
                <AreaChart data={history}>
                  <CartesianGrid stroke={THEME.border} strokeDasharray="3 3" />
                  <XAxis dataKey="time" stroke={THEME.textFaint} fontSize={10} />
                  <YAxis stroke={THEME.textFaint} fontSize={10} />
                  <Tooltip contentStyle={{ background: THEME.panel2, border: `1px solid ${THEME.border}`, fontSize: 11 }} />
                  <Area type="monotone" dataKey="cop" name="COP" stroke={THEME.cyan} fill={`${THEME.cyan}22`} />
                  <Area type="monotone" dataKey="load" name="Load %" stroke={THEME.purple} fill={`${THEME.purple}18`} />
                </AreaChart>
              </ResponsiveContainer>
            </Panel>
            <Panel title="Approach Temperatures" icon={Droplets}>
              <ResponsiveContainer width="100%" height={230}>
                <LineChart data={history}>
                  <CartesianGrid stroke={THEME.border} strokeDasharray="3 3" />
                  <XAxis dataKey="time" stroke={THEME.textFaint} fontSize={10} />
                  <YAxis stroke={THEME.textFaint} fontSize={10} />
                  <Tooltip contentStyle={{ background: THEME.panel2, border: `1px solid ${THEME.border}`, fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={baseline.evapApproachBase} stroke={THEME.green} strokeDasharray="4 4" />
                  <Line type="monotone" dataKey="evapApproach" name="Evap approach" stroke={THEME.cyan} dot={false} />
                  <Line type="monotone" dataKey="condApproach" name="Cond approach" stroke={THEME.hot} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </Panel>
          </div>
        )}

        {tab === "plant3d" && (
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 14 }}>
            <Panel title="3D Plant Model" icon={BoxIcon}>
              <ThreeDPlant
                alertLevel={alertLevel} running={running} highlightComponent={highlightComponent}
                faults={faults} setFaultManual={setFaultManual} pendingSP={pendingSP} setPendingSP={setPendingSP}
                applySetpoints={applySetpoints} autoOptimize={autoOptimize} setAutoOptimize={setAutoOptimize}
                actual={actual}
              />
            </Panel>
            <Panel title="Live Plant Parameters" icon={Activity}>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {[
                  { key: "evap", label: "Evaporator", rows: [
                    { label: "Temp", value: actual.Tevap.toFixed(1), unit: "°C", color: THEME.cyan },
                    { label: "Approach ΔT", value: actual.evapApproach.toFixed(2), unit: "°C" },
                  ] },
                  { key: "comp", label: "Compressor", rows: [
                    { label: "Power Draw", value: actual.compressorPowerKW.toFixed(0), unit: "kW" },
                    { label: "COP (actual)", value: actual.cop.toFixed(2), unit: "—" },
                  ] },
                  { key: "cond", label: "Condenser", rows: [
                    { label: "Temp", value: actual.Tcond.toFixed(1), unit: "°C", color: THEME.hot },
                    { label: "Approach ΔT", value: actual.condApproach.toFixed(2), unit: "°C" },
                  ] },
                ].map((section) => (
                  <div key={section.key}>
                    <div style={{
                      fontFamily: THEME.mono, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em",
                      marginBottom: 8, color: highlightComponent === section.key ? THEME.red : THEME.textFaint,
                      display: "flex", alignItems: "center", gap: 6,
                    }}>
                      {section.label}
                      {highlightComponent === section.key && (
                        <span style={{ color: THEME.red, fontSize: 9 }}>● likely fault source</span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                      {section.rows.map((r) => <StatPill key={r.label} {...r} />)}
                    </div>
                  </div>
                ))}
                <div style={{ borderTop: `1px solid ${THEME.border}`, paddingTop: 14 }}>
                  <div style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                    Plant Overall
                  </div>
                  <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
                    <StatPill label="Load" value={loadPct.toFixed(0)} unit="%" />
                    <StatPill label="kW/ton" value={actual.kwPerTon.toFixed(3)} unit=""
                      color={alertLevel === "critical" ? THEME.red : alertLevel === "warning" ? THEME.amber : THEME.green} />
                    <SeverityBadge severity={alertLevel} />
                  </div>
                </div>
              </div>
            </Panel>
          </div>
        )}

        {tab === "control" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Panel title="Guided Demo" icon={Play} style={{ gridColumn: "span 2" }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                {Object.entries(DEMO_SCENARIOS).map(([id, s]) => {
                  const isRunning = demo.active && demo.scenarioId === id;
                  return (
                    <button key={id} onClick={() => startDemo(id)} disabled={demo.active} style={{
                      padding: "8px 14px", borderRadius: 6, cursor: demo.active ? "default" : "pointer",
                      background: isRunning ? `${THEME.cyan}22` : THEME.panel2,
                      border: `1px solid ${isRunning ? THEME.cyan : THEME.border}`,
                      color: isRunning ? THEME.cyan : THEME.text,
                      fontFamily: THEME.mono, fontSize: 11, display: "flex", alignItems: "center", gap: 6,
                      opacity: demo.active && !isRunning ? 0.4 : 1,
                    }}>
                      <Play size={12} /> {s.label}
                    </button>
                  );
                })}
                {demo.active && (
                  <button onClick={stopDemo} style={{
                    padding: "8px 14px", borderRadius: 6, cursor: "pointer", background: `${THEME.red}18`,
                    border: `1px solid ${THEME.red}55`, color: THEME.red, fontFamily: THEME.mono, fontSize: 11,
                    display: "flex", alignItems: "center", gap: 6,
                  }}>
                    <Square size={12} /> Stop
                  </button>
                )}
                {!demo.active && (demo.progress > 0 || preDemoFaultsRef.current) && (
                  <button onClick={resetDemo} style={{
                    padding: "8px 14px", borderRadius: 6, cursor: "pointer", background: "transparent",
                    border: `1px solid ${THEME.border}`, color: THEME.textDim, fontFamily: THEME.mono, fontSize: 11,
                    display: "flex", alignItems: "center", gap: 6,
                  }}>
                    <RotateCcw size={12} /> Reset to Healthy
                  </button>
                )}
              </div>
              {(demo.active || demo.progress > 0) && (
                <div>
                  <div style={{ height: 5, background: THEME.panel2, borderRadius: 3, overflow: "hidden", border: `1px solid ${THEME.border}` }}>
                    <div style={{ height: "100%", width: `${demo.progress * 100}%`, background: THEME.cyan, transition: "width 0.2s linear" }} />
                  </div>
                  <p style={{ fontFamily: THEME.mono, fontSize: 11, color: THEME.textDim, marginTop: 8 }}>{demo.narration}</p>
                </div>
              )}
              {!demo.active && demo.progress === 0 && (
                <p style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint }}>
                  One-click scripted fault scenarios — ramps the plant into a fault over ~20-25s with
                  narration, for hands-free client demos. Any manual slider drag interrupts the demo.
                </p>
              )}
            </Panel>
            <Panel title="Setpoint Commands → Device" icon={Send}>
              <Slider label="Chilled Water Supply SP" value={pendingSP.chw} min={4} max={10} step={0.1} unit="°C" color={THEME.cyan}
                onChange={(v) => setPendingSP((sp) => ({ ...sp, chw: v }))} />
              <Slider label="Condenser Water Entering SP" value={pendingSP.cw} min={24} max={32} step={0.1} unit="°C" color={THEME.hot}
                onChange={(v) => setPendingSP((sp) => ({ ...sp, cw: v }))} />
              <button onClick={applySetpoints} style={{
                width: "100%", padding: "10px", background: THEME.cyan, color: "#04211d", border: "none", borderRadius: 6,
                fontFamily: THEME.mono, fontSize: 11, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 4,
              }}>
                <Send size={13} /> SEND COMMAND TO BMS
              </button>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontFamily: THEME.mono, fontSize: 11, color: THEME.textDim }}>
                <input type="checkbox" checked={autoOptimize} onChange={(e) => setAutoOptimize(e.target.checked)} />
                Enable auto chilled-water-reset optimization
              </label>

              <div style={{ marginTop: 16, borderTop: `1px solid ${THEME.border}`, paddingTop: 12 }}>
                <div style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint, marginBottom: 8 }}>COMMAND LOG</div>
                <div style={{ maxHeight: 180, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                  {commandLog.length === 0 && <span style={{ fontSize: 11, color: THEME.textFaint }}>No commands sent yet.</span>}
                  {commandLog.map((c) => (
                    <div key={c.id} style={{ display: "flex", justifyContent: "space-between", fontFamily: THEME.mono, fontSize: 10 }}>
                      <span style={{ color: THEME.textDim }}>{c.ts} · {c.point} → {c.value}{c.unit}</span>
                      <span style={{ color: c.status === "ACKED" ? THEME.green : THEME.amber }}>{c.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Panel>

            <Panel title="Fault Injection (Simulated Real-World Degradation)" icon={Wrench}>
              <Slider label="Evaporator Fouling" value={faults.evapFouling} min={0} max={100} step={1} unit="%" color={THEME.amber}
                onChange={(v) => setFaultManual("evapFouling", v)} />
              <Slider label="Condenser Fouling" value={faults.condFouling} min={0} max={100} step={1} unit="%" color={THEME.amber}
                onChange={(v) => setFaultManual("condFouling", v)} />
              <Slider label="Refrigerant Charge Loss" value={faults.refrigerantLoss} min={0} max={100} step={1} unit="%" color={THEME.red}
                onChange={(v) => setFaultManual("refrigerantLoss", v)} />
              <Slider label="Compressor Wear" value={faults.compressorWear} min={0} max={100} step={1} unit="%" color={THEME.red}
                onChange={(v) => setFaultManual("compressorWear", v)} />
              <p style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint, marginTop: 8 }}>
                These sliders simulate real sensor drift on the physical plant. The digital twin keeps
                calculating the healthy-baseline expectation — watch the Digital Twin tab and Alerts
                panel react in real time.
              </p>
            </Panel>
          </div>
        )}

        {tab === "alerts" && (
          <Panel title="Alert & Event Log" icon={Bell}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {alerts.length === 0 && <span style={{ fontSize: 12, color: THEME.textFaint }}>No alerts yet — system nominal.</span>}
              {alerts.map((a) => (
                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: THEME.panel2, border: `1px solid ${THEME.border}`, borderRadius: 6 }}>
                  <SeverityBadge severity={a.severity} />
                  <span style={{ fontFamily: THEME.mono, fontSize: 9, color: THEME.textFaint, width: 42 }}>{a.tag}</span>
                  <span style={{ fontSize: 12, flex: 1 }}>{a.message}</span>
                  <span style={{ fontFamily: THEME.mono, fontSize: 10, color: THEME.textFaint }}>{a.ts}</span>
                </div>
              ))}
            </div>
          </Panel>
        )}

        <div style={{ marginTop: 18, fontFamily: THEME.mono, fontSize: 9, color: THEME.textFaint }}>
          Model: COP = η₂ₙ𝒹 · T_evap(K) / (T_cond(K) − T_evap(K)) — second-law referenced chiller
          performance model. Simplified for demonstration; not a substitute for manufacturer
          performance data or real refrigerant property tables.
        </div>
    </>
  );
}

export default function App() {
  const [tab, setTab] = useState("overview");
  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(true);
  const [electricityRate, setElectricityRate] = useState(0.14); // $/kWh, shared building utility rate
  const [selectedChillerId, setSelectedChillerId] = useState(null); // null = Fleet Overview

  // Simulation loop — this is the shared "IoT telemetry" tick every chiller reacts to
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(id);
  }, [running]);

  const ctx = { tick, running, electricityRate };
  // Called explicitly (not in a loop) so hook calls stay unconditional/fixed-order per chiller slot.
  const ch0 = useChillerModel(CHILLERS[0], ctx);
  const ch1 = useChillerModel(CHILLERS[1], ctx);
  const ch2 = useChillerModel(CHILLERS[2], ctx);
  const chillers = [ch0, ch1, ch2];
  const activeChiller = chillers.find((c) => c.id === selectedChillerId) || null;

  const selectChiller = (id) => { setSelectedChillerId(id); setTab("overview"); };

  const fleetAlarms = chillers.filter((c) => c.alarmActive);
  const fleetTotalAlerts = chillers.reduce((sum, c) => sum + c.alerts.filter((a) => a.severity !== "info").length, 0);

  const tabs = [
    { id: "overview", label: "Overview", icon: LayoutGrid },
    { id: "twin", label: "Digital Twin", icon: Activity },
    { id: "trends", label: "Trends", icon: TrendingUp },
    { id: "plant3d", label: "3D Plant", icon: BoxIcon },
    { id: "control", label: "Control Room", icon: Sliders },
    { id: "alerts", label: "Alerts", icon: Bell, badge: activeChiller ? activeChiller.alerts.filter((a) => a.severity !== "info").length : 0 },
  ];

  const navBtnStyle = (active) => ({
    display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", borderRadius: 7,
    background: active ? THEME.panel2 : "transparent", border: active ? `1px solid ${THEME.borderLit}` : "1px solid transparent",
    color: active ? THEME.text : THEME.textDim, cursor: "pointer", fontSize: 12, fontFamily: THEME.sans, textAlign: "left", width: "100%",
  });

  return (
    <div style={{ background: THEME.bg, minHeight: "100%", color: THEME.text, fontFamily: THEME.sans, display: "flex" }}>
      {fleetAlarms.length > 0 && (
        <>
          <style>{`
            @keyframes alarmPulse {
              0%, 100% { box-shadow: 0 0 0 4px ${THEME.red}22, 0 8px 28px rgba(0,0,0,0.55); }
              50% { box-shadow: 0 0 0 11px ${THEME.red}33, 0 8px 28px rgba(0,0,0,0.55); }
            }
          `}</style>
          <div style={{ position: "fixed", top: 20, right: 20, zIndex: 1000, display: "flex", flexDirection: "column", gap: 10, maxWidth: 420 }}>
            {fleetAlarms.map((c) => (
              <div key={c.id} style={{
                background: "#2A0E10", border: `2px solid ${THEME.red}`, borderRadius: 10,
                padding: "14px 16px", display: "flex", gap: 12, alignItems: "flex-start",
                animation: "alarmPulse 1s ease-in-out infinite",
              }}>
                <AlertOctagon size={22} color={THEME.red} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: THEME.mono, fontSize: 11, fontWeight: 700, color: THEME.red, letterSpacing: "0.08em", marginBottom: 4 }}>
                    CRITICAL ALERT — {c.name}
                  </div>
                  <div style={{ fontSize: 13, color: THEME.text, lineHeight: 1.4 }}>{c.alarmMessage}</div>
                </div>
                <button onClick={() => c.setAlarmActive(false)} style={{ background: "transparent", border: "none", color: THEME.textDim, cursor: "pointer", padding: 0, flexShrink: 0 }}>
                  <XCircle size={16} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Sidebar */}
      <div style={{ width: 210, borderRight: `1px solid ${THEME.border}`, padding: "16px 10px", display: "flex", flexDirection: "column", gap: 4, flexShrink: 0, overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px 14px" }}>
          <Snowflake size={18} color={THEME.cyan} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>CHILLER PLANT</div>
            <div style={{ fontSize: 9, color: THEME.textFaint, fontFamily: THEME.mono }}>{chillers.length} UNITS · {chillers.reduce((s, c) => s + c.tons, 0)} TONS</div>
          </div>
        </div>

        <button onClick={() => setSelectedChillerId(null)} style={navBtnStyle(selectedChillerId === null)}>
          <LayoutGrid size={14} />
          <span style={{ flex: 1 }}>Fleet Overview</span>
          {fleetTotalAlerts > 0 && <span style={{ background: THEME.red, color: "#fff", fontSize: 9, fontFamily: THEME.mono, borderRadius: 9, padding: "1px 6px" }}>{fleetTotalAlerts}</span>}
        </button>

        <div style={{ fontFamily: THEME.mono, fontSize: 9, color: THEME.textFaint, letterSpacing: "0.08em", padding: "12px 10px 4px" }}>CHILLERS</div>
        {chillers.map((c) => {
          const count = c.alerts.filter((a) => a.severity !== "info").length;
          return (
            <button key={c.id} onClick={() => selectChiller(c.id)} style={navBtnStyle(selectedChillerId === c.id)}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: severityColor(c.alertLevel), flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{c.name}</span>
              {count > 0 && <span style={{ background: THEME.red, color: "#fff", fontSize: 9, fontFamily: THEME.mono, borderRadius: 9, padding: "1px 6px" }}>{count}</span>}
            </button>
          );
        })}

        {activeChiller && (
          <>
            <div style={{ fontFamily: THEME.mono, fontSize: 9, color: THEME.textFaint, letterSpacing: "0.08em", padding: "12px 10px 4px" }}>{activeChiller.name} DETAIL</div>
            {tabs.map((t) => {
              const active = tab === t.id;
              const Icon = t.icon;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} style={navBtnStyle(active)}>
                  <Icon size={14} />
                  <span style={{ flex: 1 }}>{t.label}</span>
                  {!!t.badge && <span style={{ background: THEME.red, color: "#fff", fontSize: 9, fontFamily: THEME.mono, borderRadius: 9, padding: "1px 6px" }}>{t.badge}</span>}
                </button>
              );
            })}
          </>
        )}

        <div style={{ marginTop: "auto", padding: "10px 8px" }}>
          <button onClick={() => setRunning((r) => !r)} style={{
            width: "100%", padding: "8px", borderRadius: 6, border: `1px solid ${THEME.border}`,
            background: running ? `${THEME.green}18` : `${THEME.textFaint}18`, color: running ? THEME.green : THEME.textDim,
            fontFamily: THEME.mono, fontSize: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}>
            <Radio size={11} /> {running ? "TELEMETRY LIVE" : "PAUSED"}
          </button>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, minWidth: 0, padding: 18, overflow: "auto" }}>
        {activeChiller ? (
          <ChillerDetailView chiller={activeChiller} tab={tab} running={running} electricityRate={electricityRate} setElectricityRate={setElectricityRate} />
        ) : (
          <FleetOverview chillers={chillers} onSelect={selectChiller} />
        )}
      </div>
    </div>
  );
}

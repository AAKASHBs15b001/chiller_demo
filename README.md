# Chiller Digital Twin

A browser-based digital twin + fleet management prototype for water-cooled
centrifugal chillers. It pairs a physics-based performance model with a
simulated IoT telemetry stream to demonstrate how digital-twin condition
monitoring, predictive maintenance, and BMS control actually work — end to
end, in a single React app.

Built as a demo/teaching tool, not a production SCADA system. See
[`SCIENTIFIC_MODEL.md`](SCIENTIFIC_MODEL.md) for the thermodynamics behind
the numbers and their limitations, and [`CLAUDE (1).md`](<CLAUDE (1).md>)
for the architecture notes.

## What it does

- **Digital twin vs. actual plant** — the same second-law (Carnot-referenced)
  physics function is evaluated twice every tick: once with zero faults (the
  "healthy baseline" twin) and once with live fault sliders (the "actual"
  plant). The gap between them drives every alert and insight in the app.
- **Fleet management** — three independently simulated chillers (different
  capacities, baselines, and starting condition) with a Fleet Overview
  dashboard and per-unit drill-down.
- **Fault injection** — evaporator/condenser fouling, refrigerant charge
  loss, and compressor wear sliders simulate real-world degradation and
  feed a live alerting engine.
- **Guided demo scenarios** — one-click, narrated fault ramps (refrigerant
  leak, condenser fouling, compressor wear) for hands-free client demos.
- **Diagnostic narrative** — a plain-language root-cause explanation,
  computed by isolating each fault through the same physics model rather
  than guessing from raw slider values.
- **Cost impact analysis** — converts the live efficiency deviation into
  $/day, $/month, and $/year figures at an editable electricity rate.
- **Predictive forecast** — fits a linear trend to recent telemetry and
  projects time-to-warning / time-to-critical if the drift continues.
- **Alarm moment** — a pulsing critical-alert banner with a synthesized
  audio tone, fired once per transition into critical state.
- **3D plant view** — a raw Three.js model (drag-orbit, zoom, auto-rotate)
  with clickable component hotspots that open real setpoint/fault controls
  anchored to the evaporator, condenser, and compressor.
- **Setpoint commands** — a simulated BMS write path (`SENT → ACKED` with
  transport delay), plus a chilled-water-reset auto-optimize heuristic.

## Running locally

```bash
cd app
npm install
npm run dev
```

Then open the printed local URL. The app starts on the Fleet Overview;
click into any chiller (CH-01/02/03) to see its full digital-twin detail
view, or open **Control Room → Guided Demo** to run a scripted scenario.

## Tech stack

- React 19 + Vite
- Three.js (raw, no react-three-fiber) for the 3D plant view
- Recharts for trend charts
- Tailwind CSS v4 for layout utilities
- lucide-react for icons

## Project structure

```
ChillerDigitalTwin.jsx   canonical source — the entire app in one file
SCIENTIFIC_MODEL.md      the thermodynamic model, explained
CLAUDE (1).md            architecture notes / extension seams
app/                     Vite project (mirrors ChillerDigitalTwin.jsx into src/)
```

`ChillerDigitalTwin.jsx` at the repo root is the source of truth; it's
synced into `app/src/ChillerDigitalTwin.jsx` to run as a normal Vite app.

## Disclaimer

Every number this app produces — COP, kW/ton, approach temperatures, cost
figures, forecasts — is illustrative. It's built on simplified, clearly
documented assumptions for demonstration purposes, not manufacturer
performance data or real refrigerant property tables.

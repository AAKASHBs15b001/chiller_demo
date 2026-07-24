# CLAUDE.md — Chiller IoT + Digital Twin Prototype

This file orients any future Claude (or engineer) working on this project. Read
this before modifying `ChillerDigitalTwin.jsx` or extending the system beyond
the browser prototype into a real IoT deployment.

## 1. What this project is

A **single-file React prototype** (`ChillerDigitalTwin.jsx`) that demonstrates
the full IoT + digital twin loop for a water-cooled centrifugal chiller:

1. A **physics-based digital twin** continuously calculates the chiller
   performance a *healthy* machine should have right now, given current
   setpoints and load.
2. A **simulated physical plant** runs the same physics model but with
   operator-injected faults (fouling, refrigerant loss, compressor wear) —
   standing in for real IoT sensor telemetry.
3. The gap between twin and plant drives an **alerting engine**.
4. An operator (or an auto-optimize heuristic) can **write setpoint commands**
   back to the simulated plant, with a realistic transport delay and an
   acknowledgement step — modeling a real BMS/BACnet write.
5. All of this is visualized in **2D** (animated refrigeration-cycle
   schematic, gauges, trend charts) and **3D** (a Three.js plant model you can
   drag-orbit, color-coded by live alert severity).

It is a teaching / demo prototype, not a production SCADA system. Treat every
number it produces as illustrative, not as real equipment engineering data.

## 2. File map

```
ChillerDigitalTwin.jsx   — the entire app (physics, UI, 2D, 3D, state)
CLAUDE.md                — this file
SCIENTIFIC_MODEL.md       — the thermodynamic model and formulas, explained
```

Everything is intentionally kept in one file so it renders directly as a
Claude.ai / Claude Code React artifact. If this grows into a real project,
split along the section markers already present in the file:
`THEME`, `SCIENTIFIC MODEL`, `SMALL UI PRIMITIVES`, `2D SCHEMATIC`,
`3D PLANT VIEW`, `MAIN APP`.

## 3. Core architecture decisions (and why)

- **One physics function, two call sites.** `computeCyclePerformance()` is
  called once with all faults zeroed (= the twin's "expected/healthy" state)
  and once with the live fault sliders (= the "actual/plant" state). This is
  the entire twin-vs-actual comparison — do not duplicate the formula
  elsewhere; always derive both states from this single function so they stay
  physically consistent.
- **Second-law (Carnot-referenced) COP model**, not a full refrigerant
  property table (no P-h/T-s lookup, no REFPROP). This keeps the model
  dependency-free and fast in-browser while still being a legitimate,
  textbook-grounded method for chiller condition monitoring. See
  `SCIENTIFIC_MODEL.md` for the reasoning and limitations.
- **Commands are asynchronous and acknowledged**, mirroring a real BMS write:
  `sendCommand()` pushes a `SENT` log entry immediately, then resolves to
  `ACKED` after a simulated transport delay, and only *then* updates
  `confirmedSP` (the value the physics model actually uses). Never make the
  physics model read from the pending slider value directly — that would
  skip the "commands take time and can fail" reality this prototype is meant
  to teach.
- **Alerts are debounced** (15s per identical message) so a noisy tick loop
  doesn't spam the alert list. If you add new alert conditions, route them
  through `pushAlert()`, not a separate mechanism.
- **3D view uses raw Three.js (r128), not react-three-fiber**, and implements
  custom drag-to-orbit because `THREE.OrbitControls` is not available in this
  environment's bundled Three version. Do not import `OrbitControls` — write
  pointer-drag camera math instead (see the `onDown/onMove/onUp` handlers).
  Also avoid `THREE.CapsuleGeometry` (r142+); use `CylinderGeometry` /
  `SphereGeometry` combinations instead.
- **Colors are theme-driven, not Tailwind arbitrary values.** This
  environment's Tailwind has no JIT compiler, so `bg-[#0A0E17]` style classes
  will not work. All custom colors live in the `THEME` object and are applied
  via inline `style`. Tailwind classes are only used for layout primitives
  that exist in the default utility set (flex, grid, padding, etc.) — this
  file currently uses inline flex/grid styles throughout for the same reason;
  keep that pattern if you add new components.

## 4. Extending toward a real deployment

If someone wants to take this from prototype to a real IoT system, the
natural seams are:

- **Replace the simulation tick** (`setInterval` in the main `useEffect`)
  with a WebSocket or MQTT-over-WebSocket subscription to real sensor topics.
  The rest of the state flow (`history`, `alerts`, twin/actual comparison)
  can stay the same — just replace where `loadPct` and the fault-equivalent
  measured values come from.
- **Replace `sendCommand()`'s `setTimeout`** with an actual API call to a
  BMS/BACnet gateway service, keeping the same `SENT → ACKED` state machine
  (add a `FAILED` status for real deployments — this prototype omits command
  failure paths).
- **Replace the fault sliders** with real derived diagnostics: instead of a
  human dragging "compressor wear," compute an estimated wear index from
  vibration/current trends over time.
- **Swap the second-law model for refrigerant property tables** (e.g. via a
  small server-side service using CoolProp) if you need engineering-grade
  accuracy rather than demonstration-grade.
- **Persist history and alerts** server-side; this prototype keeps only the
  last 40 samples and 25 alerts in memory and loses everything on refresh.

## 5. What not to do

- Don't present the kW/ton, COP, or approach-temperature numbers this
  prototype generates as real equipment performance data — they come from a
  simplified model with illustrative constants, not a specific chiller's
  actual performance curves.
- Don't wire the "Send Command" button to a real device without adding
  interlocks (min/max setpoint bounds are present here, but a real deployment
  needs rate limiting, authorization, and a manual override / e-stop path
  that this prototype does not implement).

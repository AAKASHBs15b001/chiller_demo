# Scientific Model — Chiller Digital Twin

This document explains the thermodynamics behind `ChillerDigitalTwin.jsx`, so
the numbers on screen can be defended and explained rather than treated as a
black box.

## 1. Why a second-law (Carnot-referenced) model, and not full refrigerant tables

A fully rigorous chiller model needs pressure–enthalpy (P-h) property data for
the specific refrigerant (e.g. R-134a, R-513A), compressor performance maps,
and heat-exchanger UA values. That's the right approach for real engineering
design, but it needs a property database (e.g. CoolProp/REFPROP) that isn't
appropriate to hand-roll approximately in a browser prototype — bad
correlation constants would produce numbers that *look* precise but are
actually wrong, which is worse than an honestly simplified model.

Instead, this prototype uses the **second-law / exergetic efficiency method**,
a well-established approach in chiller condition-monitoring literature:

```
COP_Carnot = T_evap(K) / (T_cond(K) − T_evap(K))
COP_actual = η₂ₙ𝒹 × COP_Carnot
```

`COP_Carnot` is the theoretical maximum COP a refrigeration cycle could
achieve operating between the evaporating and condensing temperatures — pure
thermodynamics, no refrigerant-specific data needed. `η₂ₙ𝒹` (second-law /
exergetic efficiency) captures everything that makes a real machine fall
short of that ideal: compressor isentropic inefficiency, heat exchanger
pinch/approach losses, mechanical losses, etc.

Typical `η₂ₙ𝒹` for real centrifugal/screw chillers is **0.35–0.55**. This
prototype uses **0.45** as the healthy baseline, degraded by fault sliders.

This is the same logic used in real chiller diagnostics: instead of needing
the full refrigerant cycle, you can flag degradation by watching how far
`η₂ₙ𝒹` (backed out from measured COP and measured Tevap/Tcond) has drifted
from its commissioning value.

## 2. Evaporating and condensing temperature

```
T_evap = T_chw_leaving − ΔT_evap_approach
T_cond = T_cw_entering + ΔT_cond_approach
```

- `T_chw_leaving`: the chilled-water supply setpoint (what the operator sets)
- `T_cw_entering`: condenser water entering temperature (from the cooling
  tower, treated as a direct setpoint in this prototype for simplicity)
- **Approach temperature**: the temperature difference between the
  refrigerant and the water at the pinch point of the heat exchanger. A clean
  new evaporator/condenser has a small approach (~1.5–2°C); as tubes foul
  (scale, biofilm, oil in the refrigerant) or refrigerant charge drops, the
  approach widens — this is one of the most reliable, sensor-cheap early
  warning signs in real chiller maintenance programs.

## 3. Fault-to-physics mapping used in this prototype

| Fault slider | Physical mechanism | Model effect |
|---|---|---|
| Evaporator fouling | Scale/biofilm on tubes reduces heat transfer | Widens `ΔT_evap_approach` |
| Condenser fouling | Same, on the condenser side | Widens `ΔT_cond_approach` |
| Refrigerant charge loss | Leak reduces refrigerant mass flow | Widens `ΔT_evap_approach`, drops `η₂ₙ𝒹` |
| Compressor wear | Bearing/valve/seal degradation | Drops `η₂ₙ𝒹` |

These mappings are deliberately simple linear relationships tuned to produce
plausible, demonstrable behavior — not derived from a specific manufacturer's
degradation curves.

## 4. From COP to kW/ton (the number facilities teams actually track)

```
1 ton of refrigeration = 3.517 kW
Cooling load (kW) = Cooling load (tons) × 3.517
Compressor power (kW) = Cooling load (kW) / COP
kW/ton = Compressor power (kW) / Cooling load (tons)
```

`kW/ton` is the standard efficiency metric in chiller plant operations —
lower is better. Premium high-efficiency chillers run near 0.5–0.6 kW/ton at
full load; this model's healthy baseline lands in a realistic ~0.6–0.8
kW/ton range depending on setpoints and load, which is the right ballpark for
the illustrative `η₂ₙ𝒹 = 0.45` assumption.

## 5. The digital-twin comparison

The twin and the "actual plant" call the **exact same physics function**,
differing only in whether fault terms are zero (twin) or set by the operator
(actual). The deviation:

```
Deviation % = (kW/ton_actual − kW/ton_twin) / kW/ton_twin × 100
```

is the core diagnostic signal — a real gap between what a healthy chiller
would be doing under these exact conditions right now, and what this one is
actually doing. Thresholds used in this prototype: **>8% → warning**,
**>18% → critical**. These are illustrative, not standardized values; real
programs calibrate thresholds against a specific machine's commissioning
data.

## 6. Chilled-water reset optimization

The auto-optimize heuristic implements the classic **chilled-water-supply
reset** energy strategy: at part load, the chiller doesn't need to make water
as cold, so raising the setpoint reduces the compressor's lift (the
`T_cond − T_evap` gap), directly improving `COP_Carnot`. The prototype's
heuristic raises the setpoint up to +2.2°C when load drops below 65%,
scaling down to no reset above that — a simplified version of the reset
schedules used in real building automation systems.

## 7. Explicit limitations

- No refrigerant-specific P-h property data — this is a thermodynamic-limit
  model, not a full cycle simulation.
- Condenser water entering temperature is treated as a free setpoint rather
  than derived from a cooling-tower + wet-bulb model.
- Fault-to-physics coefficients are illustrative, not fitted to real
  equipment data.
- No transient/thermal-mass dynamics — every tick recalculates steady-state
  performance for the current conditions; there's no "spin-up" behavior.

These are appropriate simplifications for a teaching/demo digital twin, and
are called out explicitly so nobody mistakes this for validated engineering
software.

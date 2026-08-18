# [OPEN] chart-filter-loop

## Symptom
- `Maximum update depth exceeded` in `Dashboard.jsx`
- Chart panel selection does not show the expected classification layer on the map

## Hypotheses
1. `ChartPanel` has a `useEffect` that depends on `onFilterChange`, while `Dashboard` passes it inline, so the dependency changes every render and loops.
2. The rerender loop prevents `baseFilter -> roadFilter -> classification layer visibility` from settling, so no layer becomes visible.
3. `ChartPanel` chart callbacks are also passed inline and add unnecessary parent rerenders during chart interaction.
4. The GeoServer SLD itself is not the primary issue here; the layer activation path is failing before the intended classification layer can render stably.

## Current Evidence
- `ChartPanel.jsx` filter effect depends on `onFilterChange`
- `Dashboard.jsx` passes `onFilterChange` inline at the line reported in the console
- Classification visibility is already controlled elsewhere through `onClassificationChange`, so the correct path is to stabilize callbacks, not override layer styling
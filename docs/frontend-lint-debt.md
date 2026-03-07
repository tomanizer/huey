# Frontend lint warning budget

Huey's frontend lint currently runs with a warning budget to stop debt from growing while legacy modules are cleaned up incrementally.

## Current budget

- Command: `npm run lint:js`
- Source of truth: `package.json` → `scripts.lint:js`
- CI entry point: `.github/workflows/query-service.yml` → `frontend-lint`

This budget must only move downward. If a change reduces warnings, lower the budget in `package.json` in the same pull request.

## Burn-down focus

Start with the highest-risk modules called out in issue tracking:

1. `src/PivotTableUi/PivotTableUi.js`
2. `src/QueryModel/QueryModel.js`
3. `src/DataSet/CellSet.js`

Prefer low-risk mechanical fixes first:

- remove unnecessary `async`
- replace unused variables
- convert `var` to `let`/`const`
- simplify obvious equality and callback issues

## Milestones

- [x] Set an initial enforced budget in `package.json`
- [x] Reduce warnings in `src/PivotTableUi/PivotTableUi.js`
- [ ] Lower the budget to 40 warnings
- [ ] Lower the budget to 30 warnings
- [ ] Lower the budget to 20 warnings
- [ ] Revisit stricter per-directory or changed-file enforcement once the legacy hotspots are smaller

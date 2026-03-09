# UI performance validation (C3.2)

This document describes how to validate Huey UI performance for both local and remote modes.

## Scope

- **Time to interactive:** App loads and main UI is visible within an acceptable time (e.g. a few seconds on a typical connection).
- **Remote mode:** First schema load, first tuple/cell fetch, and filter picklist respond within acceptable latency (driven by QueryService and network).
- **Local mode:** Pivot and filter interactions remain responsive with in-browser DuckDB-WASM.

## Manual checks

1. **Load:** Open Huey (local or served); confirm the workarea and sidebar appear within a few seconds; no long blank screen.
2. **Remote:** With QueryService running, add a remote datasource and explore; confirm attributes load and first pivot runs without excessive delay (network-dependent).
3. **Local:** Upload a moderate-sized file (e.g. 10–50 MB CSV/Parquet); build a pivot and apply a filter; confirm interactions (e.g. changing axes, opening picklist) stay responsive.
4. **Large result sets:** With many rows/columns, scrolling and rendering should remain usable; consider reducing page size or enabling virtualization if added later.

## Automated smoke (Playwright)

The existing UI smoke test (`npm run test:ui`) verifies that the app loads and the main UI is visible. It does not assert specific performance thresholds. To add performance gates later:

- Use Playwright’s `page.waitForLoadState('domcontentloaded')` and measure time to a stable selector (e.g. `#workarea` visible).
- Fail the build if time exceeds a threshold (e.g. 10 s in CI).

For automated local-mode benchmarking and baseline comparison, see [frontend-performance-benchmarks.md](./frontend-performance-benchmarks.md).

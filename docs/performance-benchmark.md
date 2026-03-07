# PivotTableUi performance benchmark

## Benchmark dataset

- Fixture: `/home/runner/work/huey/huey/tests/ui/fixtures/performance-benchmark.csv`
- Shape: 10,980 data rows + header row
- Columns:
  - `date`
  - `symbol`
  - `volume`
  - `price`
- Suggested pivot:
  - Rows: `date`
  - Columns: `symbol`
  - Cells: `sum(volume)`

The fixture uses 366 dates and 30 symbols so it is large enough to exercise the initial visible render path and the virtual scrolling updates.

## Rendering changes in this patch

- Batched initial header, row, and cell insertion with `DocumentFragment`
- Yielded long initial render phases with `requestAnimationFrame`
- Used `Math.floor` for scroll-position-to-physical-index calculations to avoid sub-pixel overshoot
- Added CSS containment on the pivot table container and scroller

## How to collect before/after numbers locally

1. Start Huey locally.
2. Load `tests/ui/fixtures/performance-benchmark.csv`.
3. Build a pivot with:
   - `date` on rows
   - `symbol` on columns
   - `sum(volume)` in cells
4. Open Chrome DevTools Performance panel.
5. Enable 6× CPU slowdown.
6. Record:
   - initial render
   - a vertical scroll pass
   - a horizontal scroll pass
7. Capture:
   - total render time
   - scripting time
   - layout/paint time
   - largest task duration
   - observed scroll FPS

Huey also exposes the in-app render summary in the toolbar as `Query: <ms> | Render: <ms>`, which is useful for quick comparisons before opening a full Performance trace.

## Sandbox note

The coding sandbox used for this change blocks the external DuckDB WASM CDN import in browser automation, so a full Chrome DevTools trace could not be captured here. The fixture and method above are included so the same benchmark can be repeated locally against the exact patch contents.

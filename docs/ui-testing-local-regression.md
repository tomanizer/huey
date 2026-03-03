# UI regression tests – Local mode (DuckDB-WASM)

This document describes regression testing for Huey’s **local** datasource path (file upload, DuckDB-WASM). It ensures that adding remote/QueryService support does not break existing local behaviour.

## Scope (C2.2)

- **Local datasources:** Upload CSV/Parquet/JSON/DuckDB files, register in DuckDB-WASM, explore.
- **Attributes and query:** Attribute list from local schema, build query (rows, columns, measures), run pivot.
- **Filters:** Filter axis, picklist from local data, apply filters.
- **Export:** Export results (CSV, Parquet, JSON) and SQL.

## Prerequisites

- Huey served (e.g. `npx serve src -p 8765`) or open `src/index.html` from a server (required for WASM).
- No backend required; all data stays in the browser.

## Manual regression checklist

1. **Upload**
   - Upload a small CSV/Parquet file; confirm it appears under Datasources and can be explored.
   - Upload a .duckdb file; confirm schema/tables appear and can be explored.

2. **Query**
   - Place attributes on rows and columns, add a measure; confirm pivot table updates and shows data.

3. **Filters**
   - Add a filter, open picklist, select values, apply; confirm results are filtered.

4. **Export**
   - Export pivot results to CSV (and optionally Parquet/JSON); confirm file content is correct.

5. **URL state**
   - Change query, confirm URL fragment updates; reload and confirm query restores (with same datasource).

## Automated smoke (shared with remote)

When Playwright UI tests are present (see `docs/ui-testing-remote.md`), `npm run test:ui` runs a smoke test that loads the app and checks the main UI. That run exercises the same code path as opening Huey for local use and acts as a basic regression check: the app loads and the workarea/sidebar are visible. Full local flows (upload, pivot, filter, export) are covered by the manual checklist above.

# UI tests – Remote mode (QueryService)

This document describes how to test Huey’s remote datasource integration (QueryService) in the browser.

## Scope (C2.1)

- **Remote datasource:** Adding a remote datasource (base URL + dataset ID), loading schema from `/schema`, and seeing attributes in the Attribute UI.
- **Tuple/cell fetching:** Running a pivot query and seeing rows/cells from `/query/tuples` and `/query/cells`.
- **Filter picklist:** Opening a filter, seeing values from `/query/picklist`.
- **Loading and errors:** Loading states and error dialogs when the backend is slow or returns errors.

## Prerequisites

1. QueryService running (e.g. `cd server && uvicorn server.main:app --port 8000`).
2. Huey served from the same origin or with CORS allowed (e.g. `npx serve src -p 8080` or open `src/index.html` from a server).
3. A configured dataset (e.g. `trades_v1` in `server/datasets_config/datasets.yaml`).

## Manual test flow

1. Open Huey (e.g. `http://localhost:8080/index.html`).
2. Use “Load data from URL” or the URL that registers a remote datasource (base URL = QueryService, e.g. `http://localhost:8000`, dataset ID = `trades_v1`).
3. Explore the datasource: confirm attributes load from schema.
4. Build a query (rows, columns, measures): confirm tuples and cells load.
5. Add a filter and open the filter picklist: confirm values load.
6. Trigger an error (e.g. stop the server, invalid date range): confirm error handling and messages.

## Automated smoke test (Playwright)

From repo root, with Node installed:

```bash
npm ci
npx playwright install chromium
npm run test:ui
```

(CI uses the same policy explicitly via `PLAYWRIGHT_PROJECTS=chromium`, so only Chromium is installed and executed in the e2e job. Local runs without `PLAYWRIGHT_PROJECTS` keep all configured browser projects.)

(The smoke test starts a static server on port 8765 and runs one test that loads the app and checks the main UI is visible.)

The smoke test opens the app and checks that the main UI (e.g. datasource area, toolbar) is present. Full remote flows (schema, tuples, picklist) are covered by manual testing and backend integration tests.

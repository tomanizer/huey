# Run and test the remote dataset (QueryService) – step by step

This guide walks through running **QueryService** (the backend), serving **Huey** (the frontend), adding a **remote datasource**, and verifying that schema and queries work end-to-end.

---

## Prerequisites

- **Python 3.11+** (required by QueryService)
- **Node.js 20+ and npm 10+** (for `npx serve` to serve the frontend; or any static file server)
- **Repo root** = directory containing `server/` and `src/`

---

## Step 1: Backend – create venv and install dependencies

From the **repo root**:

```bash
python3 -m venv .venv-server
./.venv-server/bin/pip install -r server/requirements.txt
```

(On Windows use `.venv-server\Scripts\pip` and `.venv-server\Scripts\activate` as needed.)

---

## Step 2: (Optional) Enable sample data so `trades_v1` has rows

By default, QueryService does **not** seed data. The `trades_v1` dataset in `server/datasets_config/datasets.yaml` has only schema (no S3/parquet source). To have a real table with sample rows for testing:

**Option A – environment variable (recommended for testing):**

```bash
export QUERYSERVICE_SEED_SAMPLE_DATA=true
```

**Option B – `.env` file in repo root:**

Create or edit `.env` and add:

```
QUERYSERVICE_SEED_SAMPLE_DATA=true
```

If you skip this, the schema will still load in the UI, but **queries may fail** with “table does not exist” or similar, because no `trades_v1` table is created.

---

## Step 3: Start QueryService

The browser (Huey at port 8765) must be allowed to call the API (port 8000). Set CORS so the server accepts requests from the frontend origin:

```bash
export QUERYSERVICE_CORS_ORIGINS=http://localhost:8765
```

From the **repo root** (so `server/` and config paths resolve correctly):

```bash
# With venv activated (optional):
. .venv-server/bin/activate
uvicorn server.main:app --host 0.0.0.0 --port 8000
```

Or without activating the venv:

```bash
./.venv-server/bin/uvicorn server.main:app --host 0.0.0.0 --port 8000
```

Leave this terminal running. If you use a different port for the frontend (e.g. 3000), set `QUERYSERVICE_CORS_ORIGINS=http://localhost:3000`. You should see something like:

```
INFO:     Uvicorn running on http://0.0.0.0:8000
```

**Quick sanity check:**

```bash
curl -s 'http://localhost:8000/health/liveness'
# Expect: {"status":"ok"} or similar

curl -s 'http://localhost:8000/schema?dataset_id=trades_v1'
# Expect: JSON with "fields" array (date, symbol, volume)
```

---

## Step 4: Serve the Huey frontend

The app must be loaded over **HTTP** (not `file://`) so it can call the API. From the **repo root**:

```bash
npx serve src -p 8765
```

(If you don’t have `npx`, install Node.js 20+/npm 10+ or use another static server, e.g. `python -m http.server 8765` from `src/`.)

Leave this running. Open in the browser:

**http://localhost:8765/index.html**

---

## Step 5: Add a remote datasource in the UI

1. In the Huey UI, open the **Upload** area (toolbar: click **Upload…** or the area that contains “Data from URL” and “Remote dataset”).
2. Click the **“Remote dataset”** button.
3. In the dialog:
   - **Base URL:** `http://localhost:8000` (or the port your QueryService is actually on, e.g. `http://localhost:8002`)
   - **Dataset ID:** `trades_v1`
4. Click **Accept** (or **Yes**).

The remote datasource should appear under the **Datasources** tab in the sidebar (often under a “remote” or similar group).

---

## Step 6: Explore and run a query

1. In the sidebar, find the **remote** datasource (e.g. “trades_v1” or “remote – trades_v1”).
2. Click the **Explore** (analyze) button next to it.
3. The app will call QueryService:
   - **Schema:** `GET /schema?dataset_id=trades_v1` → attributes (date, symbol, volume) appear.
   - **Tuples/cells:** when you add rows/columns/measures and run a query, it uses `POST /query/tuples` and `POST /query/cells`.
4. Add at least one attribute to **Rows** or **Columns** and a **Measure** (e.g. volume → Sum), then run the query (e.g. **Run** or auto-run if enabled).

If sample data was seeded, you should see data in the pivot table. If not, you may see empty results or an error; the schema and flow should still demonstrate the remote path.

---

## Step 7: Verify from the command line (optional)

**Schema:**

```bash
curl -s 'http://localhost:8000/schema?dataset_id=trades_v1'
```

**Tuples (example):**

```bash
curl -s -X POST 'http://localhost:8000/query/tuples' \
  -H 'Content-Type: application/json' \
  -d '{
    "dataset_id": "trades_v1",
    "date_range": {"type": "single", "date": "2026-03-01"},
    "query": {
      "fields": [{"field": "symbol", "sort": "ASC"}],
      "paging": {"limit": 10, "offset": 0}
    }
  }'
```

**Cells (example):**

```bash
curl -s -X POST 'http://localhost:8000/query/cells' \
  -H 'Content-Type: application/json' \
  -d '{
    "dataset_id": "trades_v1",
    "date_range": {"type": "single", "date": "2026-03-01"},
    "query": {
      "axes": {
        "rows": [{"field": "symbol"}],
        "measures": [{"field": "volume", "aggregation": "SUM", "alias": "total_volume"}]
      },
      "max_rows": 1000
    }
  }'
```

With `QUERYSERVICE_SEED_SAMPLE_DATA=true`, these should return data (or at least structure). Without it, tuples/cells may error or return empty depending on backend behavior.

---

## Step 8: Add remote datasource via browser console (optional)

With the app open at http://localhost:8765/index.html, open DevTools (F12) → **Console**, then:

```javascript
var config = RemoteDatasourceConfig.createRemoteDatasourceConfig({
  baseUrl: 'http://localhost:8000',
  datasetId: 'trades_v1'
});
var ds = new RemoteDatasource(config);
datasourcesUi.addDatasource(ds);
```

The remote datasource should appear in the sidebar; then use **Explore** as in Step 6.

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| **404 on /schema or “Not Found” when clicking Analyze** | QueryService did not find the dataset. **Start the server from the repository root** so it can load `server/datasets_config/datasets.yaml`: run `uvicorn server.main:app ...` from the directory that contains the `server/` folder. If you still get 404, set `QUERYSERVICE_DATASETS_CONFIG_PATH` to the **absolute** path to that YAML (e.g. `/path/to/huey/server/datasets_config/datasets.yaml`). Then restart the server and run `curl -s 'http://localhost:8000/schema?dataset_id=trades_v1'` to confirm it returns JSON with a `fields` array. |
| **CORS: "blocked by CORS policy" or "Failed to fetch"** | Start QueryService with `QUERYSERVICE_CORS_ORIGINS=http://localhost:8765`. Restart the server. Required even if the server runs on a different port (e.g. 8002). |
| **Wrong port** | Base URL must match the port QueryService runs on (e.g. `http://localhost:8002`). Remove the old remote and add it again with the correct URL. |
| **CORS errors in browser** | QueryService CORS: set `QUERYSERVICE_CORS_ORIGINS` to include `http://localhost:8765` (or use `*` for local dev). Restart the server. |
| **“Dataset not found”** | Ensure `dataset_id` is exactly `trades_v1` and that `server/datasets_config/datasets.yaml` (or the path in `QUERYSERVICE_DATASETS_CONFIG_PATH`) contains a dataset with that `dataset_id`. |
| **Schema loads but query fails** | Enable `QUERYSERVICE_SEED_SAMPLE_DATA=true` so the `trades_v1` table exists and is seeded. Restart QueryService. |
| **Connection refused to localhost:8000** | Ensure uvicorn is running (Step 3) and nothing else is using port 8000. |
| **Blank or 404 on index.html** | Ensure you opened `http://localhost:8765/index.html` (or the correct port) and that `npx serve src` is serving the `src` directory. |

---

## Summary checklist

- [ ] Venv created and `server/requirements.txt` installed
- [ ] (Optional) `QUERYSERVICE_SEED_SAMPLE_DATA=true` set
- [ ] QueryService running on port 8000; `/health/liveness` and `/schema?dataset_id=trades_v1` respond
- [ ] Frontend served over HTTP (e.g. port 8765); opened in browser
- [ ] “Remote dataset” → Base URL `http://localhost:8000`, Dataset ID `trades_v1` → Accept
- [ ] Remote datasource visible in sidebar; Explore → schema loads; query runs (with or without rows depending on seeding)

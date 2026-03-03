# Try the Huey remote (QueryService) feature

Quick steps to run Huey with a **remote datasource** backed by QueryService.

## 1. Start QueryService

From the repo root:

```bash
. .venv-server/bin/activate
uvicorn server.main:app --host 0.0.0.0 --port 8000
```

Leave this running. The API will be at `http://localhost:8000` (health: `http://localhost:8000/health/liveness`).

## 2. Serve Huey

Huey must be loaded from a **web server** (not `file://`) so it can call the API. From the repo root:

```bash
npx serve src -p 8765
```

Open **http://localhost:8765/index.html** in your browser.

## 3. Add a remote datasource

In the toolbar, click **“Remote dataset”**. In the dialog, enter:

- **Base URL:** `http://localhost:8000` (or your QueryService URL)
- **Dataset ID:** `trades_v1`

Click **Yes** (or Accept). The remote datasource appears under **“remote”** in the **Datasources** tab in the sidebar.

Alternatively, from the **browser console** (F12 → Console):

```javascript
var config = RemoteDatasourceConfig.createRemoteDatasourceConfig({
  baseUrl: 'http://localhost:8000',
  datasetId: 'trades_v1'
});
var ds = new RemoteDatasource(config);
datasourcesUi.addDatasource(ds);
```

## 4. Explore and run a query

1. Click the **Explore** (analyze) button next to the remote datasource.
2. Attributes load from QueryService (`/schema`); add rows/columns/measures and run a query.
3. Tuples and cells are fetched from `/query/tuples` and `/query/cells`; filters use `/query/picklist`.

The default config includes a `trades_v1` dataset (see `server/datasets_config/datasets.yaml`). The backend returns empty result sets until real data/engine wiring is added; the UI should still load schema and run the flow without errors.

# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Huey is a browser-based data exploration tool with two components:

- **Frontend** (JavaScript/Vite): SPA in `src/`, dev server on port 8765.
- **QueryService Backend** (Python/FastAPI/DuckDB): in `server/`, runs on port 8000. Optional — the frontend works standalone with DuckDB-WASM.

### Validation commands

See `.github/copilot-instructions.md` for the full list. Key commands:

| Area | Command |
|------|---------|
| Frontend install | `npm ci` |
| Frontend lint | `npm run lint:js` |
| Frontend build | `npm run build` |
| Frontend unit tests | `npm run test:unit` |
| Frontend dev server | `npm run dev` (port 8765) |
| Backend install | `.venv-server/bin/pip install -r server/requirements.txt` |
| Backend lint | `.venv-server/bin/ruff check server/` |
| Backend tests | `PYTHONPATH=. .venv-server/bin/python -m pytest server/tests -q` |
| Backend dev server | see below |

### Non-obvious caveats

- **Backend export path**: The QueryService defaults to `/data/exports` for export storage, which doesn't exist in the dev environment. Start the backend with:
  ```
  PYTHONPATH=. QUERYSERVICE_EXPORT_OUTPUT_DIR=/tmp/huey-exports QUERYSERVICE_EXPORT_DB_PATH=/tmp/huey-exports/jobs.db .venv-server/bin/uvicorn server.main:app --host 0.0.0.0 --port 8000
  ```
- **python3.12-venv**: The system Python may not have the `venv` module pre-installed. The update script handles `apt install python3.12-venv` automatically.
- **ruff**: Not in the backend `requirements.txt`; install it separately in the venv (`pip install ruff`).
- **Backend lint warnings**: `ruff check server/` reports pre-existing unused-variable warnings (F841) in `server/routers/query.py` and an unused import (F401) in tests. These are known and not blocking.
- **Autorun Query**: When testing the frontend UI manually, the "Autorun Query" setting may be disabled by default. Enable it via Settings > Query tab, or click the play button in the toolbar after configuring a query.

# AGENTS.md

Guidance for coding agents working in this repository.

## 1) Project overview

Huey is a browser-based analytics app with:

- **Frontend**: vanilla JS app under `src/`, built with Vite.
- **Backend (QueryService)**: FastAPI + DuckDB service under `server/`.

Primary docs:

- `README.md` (project overview)
- `docs/server/README.md` (backend docs index)
- `docs/server/api-reference.md` (backend API contracts)

## 2) Repository map

- `src/` – frontend app code (UI, datasource adapters, query model)
- `server/` – backend API, engine, config, tests
- `tests/unit/` – frontend unit tests (Vitest)
- `tests/ui/` – Playwright UI tests
- `docs/` – architecture, orchestration, and server docs

## 3) Environment and setup

From repo root:

```bash
npm ci
```

Backend virtualenv (recommended for backend changes):

```bash
python3 -m venv .venv-server
./.venv-server/bin/pip install -r server/requirements.txt
```

## 4) Common commands

Frontend:

```bash
npm run dev
npm run build
npm run lint:js
npm run test:unit
npm run test:ui
```

Backend:

```bash
./.venv-server/bin/uvicorn server.main:app --host 0.0.0.0 --port 8000
./.venv-server/bin/pytest server/tests -q
```

## 5) Change rules for agents

1. Keep changes tightly scoped to the task; avoid unrelated refactors.
2. Preserve existing architecture and module boundaries.
3. Prefer minimal, readable fixes over broad rewrites.
4. Update docs when behavior, config, or API contracts change.
5. Do not commit secrets or environment-specific credentials.

## 6) Frontend guidance

- Maintain current vanilla-JS style and existing component/module patterns.
- Keep both local datasource flows and remote datasource flows working.
- For query/state behavior, check interactions between:
  - `src/QueryModel/`
  - `src/DataSource/`
  - `src/QueryUi/`

## 7) Backend guidance

- Keep API responses consistent with docs in `docs/server/`.
- Reuse existing utilities/modules (errors, config, budgets, caching) before adding new abstractions.
- Add or update tests in `server/tests/` for endpoint or behavior changes.

## 8) Validation checklist (before finishing)

Run what is relevant to your change:

- `npm run lint:js`
- `npm run test:unit`
- `./.venv-server/bin/pytest server/tests -q`

For UI-facing changes, run Playwright when feasible:

- `npm run test:ui`

If any suite cannot be run, clearly document what was skipped and why.

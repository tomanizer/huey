# Repository Guidelines

## Project Structure & Module Organization
Huey combines a Vite-based frontend with a FastAPI backend. Keep changes scoped to the area you touch.

- `src/` — vanilla JS UI, datasource adapters, and query state modules.
- `server/` — QueryService API, DuckDB engine, config, middleware, and backend tests.
- `tests/unit/` — Vitest coverage for frontend modules.
- `tests/ui/` — Playwright end-to-end UI coverage.
- `docs/` — architecture notes plus backend references such as `docs/server/api-reference.md`.

## Build, Test, and Development Commands
Install frontend dependencies from the repo root with `npm ci`.

- `npm run dev` — start the Vite frontend locally.
- `npm run build` — create a production frontend build.
- `npm run lint:js` — run ESLint on `src/`.
- `npm run test:unit` — run frontend unit tests with Vitest.
- `npm run test:ui` — run Playwright UI tests.
- `python3 -m venv .venv-server && ./.venv-server/bin/pip install -r server/requirements.txt` — set up the backend environment.
- `./.venv-server/bin/uvicorn server.main:app --host 0.0.0.0 --port 8000` — run the backend locally.
- `./.venv-server/bin/pytest server/tests -q` — run backend tests.

## Coding Style & Naming Conventions
Match the existing style rather than introducing new patterns.

- Frontend: ES modules, vanilla JS, and component-style folders under `src/`; use PascalCase for UI module directories and files like `QuickQueryMenu/QuickQueryMenu.js`.
- Backend: follow Python conventions with `snake_case` modules, FastAPI routers, and reusable utilities in `server/`.
- Use existing linters and format naturally for the language; avoid broad refactors or unnecessary abstractions.

## Testing Guidelines
Add or update tests for behavior changes, especially API contracts and query flows.

- Frontend tests use Vitest in `tests/unit/`.
- UI tests use Playwright in `tests/ui/`.
- Backend tests live in `server/tests/` and use `pytest` with `test_*.py` naming.
- Before finishing, run the suites relevant to your change and note anything skipped.

## Commit & Pull Request Guidelines
Recent history favors short, imperative commit subjects such as `Fix nested context menu keyboard navigation` or scoped series like `Phase 2: extract QueryModelConstants...`.

- Keep commit messages concise, specific, and action-oriented.
- PRs should summarize the change, list validation performed, and link related issues.
- Include screenshots or UI notes for visible frontend changes.

## Security & Configuration Tips
Do not commit secrets or machine-specific settings. If backend behavior or responses change, update the corresponding docs in `docs/server/`. Reuse existing backend utilities for errors, caching, budgets, and config before adding new modules.

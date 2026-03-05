# Copilot instructions for `tomanizer/huey`

## Repository structure

- Frontend app code is in `/src`.
- Frontend tests are in `/tests/unit` (Vitest) and `/tests/e2e` (Playwright).
- Backend QueryService code is in `/server`.
- Backend tests are in `/server/tests`.

## Tech stack and conventions

- Frontend: plain JavaScript with Vite.
- Backend: Python 3.11+, FastAPI, DuckDB.
- Keep changes small and focused on the issue being solved.
- Reuse existing patterns in nearby files; do not refactor unrelated code.

## Validation commands

Run the commands relevant to the area you change:

- Frontend install: `npm ci`
- Frontend lint: `npm run lint:js`
- Frontend build: `npm run build`
- Frontend unit tests: `npm run test:unit`
- Frontend UI tests: `npm run test:ui`
- Backend install: `pip install -r server/requirements.txt`
- Backend lint: `ruff check server/`
- Backend tests: `PYTHONPATH=. python -m pytest server/tests -q`

## Documentation references

- Root project overview: `/README.md`
- Backend quick start and docs index: `/server/README.md`
- Workflow and CI expectations: `/.github/workflows/query-service.yml`

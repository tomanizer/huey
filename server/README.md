# QueryService (Huey Backend)

FastAPI + DuckDB backend for Huey analytics queries and exports.

Primary docs entrypoint:

- [Backend Documentation Index](../docs/server/README.md)

Direct references:

- [API Reference](../docs/server/api-reference.md)
- [Configuration Reference](../docs/server/configuration-reference.md)
- [Troubleshooting and FAQ](../docs/server/troubleshooting.md)
- [Architecture Walkthrough](./docs/architecture.md)

## Quick Start

From repo root:

```bash
python3 -m venv .venv-server
./.venv-server/bin/pip install -r server/requirements.txt
./.venv-server/bin/uvicorn server.main:app --host 0.0.0.0 --port 8000
```

Smoke checks:

```bash
curl http://localhost:8000/health/liveness
curl 'http://localhost:8000/schema?dataset_id=trades_v1'
```

Run tests:

```bash
./.venv-server/bin/pytest server/tests -q
```

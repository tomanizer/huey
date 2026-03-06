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

## Rate limiting behind reverse proxies

When running behind nginx/Caddy/ALB/Cloudflare, set
`QUERYSERVICE_TRUSTED_PROXY_COUNT` to the number of trusted proxy hops in
front of QueryService so forwarded client IPs are interpreted safely. The
default is `0` (do not trust forwarding headers), which is recommended when
QueryService is directly internet-facing.

When authentication is enabled, rate limits can be keyed by API identity using
`QUERYSERVICE_RATE_LIMIT_BY_API_KEY=true` (default).

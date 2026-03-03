#!/usr/bin/env bash
# Create GitHub issues for Huey Large-Scale OLAP implementation plan.
# Issues are created in the fork tomanizer/huey only (never in rpbouman/huey).
# Usage: ./scripts/create-olap-issues.sh [REPO]
#   REPO defaults to tomanizer/huey. Override with GH_REPO or pass as first arg.
set -e
REPO="${1:-${GH_REPO:-tomanizer/huey}}"
echo "Creating issues in $REPO (fork only; not rpbouman/huey)"
BASE="https://github.com/tomanizer/huey/blob/main/docs"

issue() {
  local id="$1"
  local title="$2"
  local body="$3"
  local labels="$4"
  if [[ -n "$labels" ]]; then
    gh issue create -R "$REPO" --title "[$id] $title" --body "$body" --label "$labels"
  else
    gh issue create -R "$REPO" --title "[$id] $title" --body "$body"
  fi
}

body_brd() {
  echo "**References:** [BRD]($BASE/huey-large-scale-olap-brd.md) | [Tech Spec]($BASE/huey-large-scale-olap-tech-spec.md) | [Architecture]($BASE/huey-large-scale-olap-architecture.md)"
}

# Track A – Backend QueryService
issue "A1.1" "Create QueryService skeleton" \
"Create base project layout (e.g. \`backend/query-service/\`) with HTTP server, routing, config loader (YAML/JSON + env). Add \`/health/liveness\` and \`/health/readiness\` endpoints and structured logging with request ID.

**Acceptance:**
- Service starts and returns 200 on \`/health/liveness\`
- Config path configurable via env

$(body_brd)" "area:backend"

issue "A1.2" "CI pipeline and basic checks" \
"Add CI workflows for build, lint/format, and unit tests. PRs must pass CI before merge.

$(body_brd)" "area:backend"

issue "A2.1" "Dataset configuration loader" \
"Define config format mapping \`dataset_id\` to S3 bucket/path template, partitioning scheme (date field, layout), and schema metadata path. Load and validate at startup.

$(body_brd)" "area:backend"

issue "A2.2" "Implement GET /schema endpoint" \
"Implement \`GET /schema?dataset_id=...\` returning field names, types, dimension/measure flags. Unit tests for valid and unknown dataset IDs.

$(body_brd)" "area:backend"

issue "A3.1" "Analytical engine integration" \
"Integrate chosen engine (e.g. DuckDB embedded). Provide abstraction for running SQL; minimal connection management and error handling.

$(body_brd)" "area:backend"

issue "A3.2" "S3 connectivity" \
"Implement S3 config (endpoint, region, credentials). Helper to read a sample partition (\`date=YYYY-MM-DD\`). Diagnostic endpoint or CLI to verify connectivity.

$(body_brd)" "area:backend"

issue "A4.1" "Implement POST /query/tuples (basic)" \
"Accept single axis (rows/columns), single field, simple IN filters, single-day date_range. Translate to GROUP BY + LIMIT/OFFSET; return values and total_count. Unit tests for happy path and unknown fields/datasets.

$(body_brd)" "area:backend"

issue "A4.2" "Implement POST /query/cells (basic)" \
"Support single row field, single column field, 1–2 measures (SUM/COUNT). Grouped aggregate; map results to row/column indexes. Tests with deterministic sample data.

$(body_brd)" "area:backend"

issue "A5.1" "Implement POST /query/picklist" \
"Distinct values for a field with date_range + filters, paging (limit/offset), optional search. Tests for high-cardinality and filter interaction.

$(body_brd)" "area:backend"

issue "A5.2" "Implement POST /export (MVP)" \
"Synchronous export for small result sets, CSV output. Refactor to async jobs later.

$(body_brd)" "area:backend"

issue "A6.1" "Date-range support and guardrails" \
"Extend queries to multi-day date_range. Configurable max range and volume guardrails.

$(body_brd)" "area:backend"

issue "A6.2" "Timeouts and resource limits" \
"Per-query time limits at engine and service level. Max tuple/cell counts per request.

$(body_brd)" "area:backend"

issue "A6.3" "Observability and metrics" \
"Metrics for endpoint QPS, latency, errors, timeouts. Integrate with metrics stack.

$(body_brd)" "area:backend"

issue "A6.4" "Authentication and authorization (initial)" \
"Token or header-based auth. Per-dataset allow lists or simple policies.

$(body_brd)" "area:backend"

# Track B – Huey RemoteDatasource Integration
issue "B1.1" "Remote datasource configuration model" \
"Introduce config for remote datasets: API base URL, dataset IDs, optional auth token source. Document where config is defined (static vs env).

$(body_brd)" "area:frontend"

issue "B1.2" "RemoteDatasource abstraction" \
"Implement RemoteDataSource class calling QueryService via fetch. Expose getSchema, getTuples, getCells, getPicklist, export. Keep parallel to DuckDbDataSource. Tests against mock QueryService.

$(body_brd)" "area:frontend"

issue "B2.1" "Attribute UI backed by /schema" \
"Integrate Attribute UI with RemoteDataSource: fetch fields from /schema, display dimension/measure metadata. Consistent derived attributes/aggregations (subset ok initially).

$(body_brd)" "area:frontend"

issue "B3.1" "Tuple fetching via /query/tuples" \
"Update TupleSet (or equivalent) to fetch tuples from RemoteDataSource for remote datasets. Map axis definitions to /query/tuples request body. Scrolling requests appropriate windows.

$(body_brd)" "area:frontend"

issue "B3.2" "Cell fetching via /query/cells" \
"Update CellSet to request cells via /query/cells. Scrolling and viewport-based fetching work with correct row/column windows.

$(body_brd)" "area:frontend"

issue "B4.1" "Filter picklists via /query/picklist" \
"Wire filter dialog to /query/picklist for remote datasets. Global filters included in picklist queries.

$(body_brd)" "area:frontend"

issue "B4.2" "Filter application and query mapping" \
"Map Huey filter state to backend filter model. Align semantics (e.g. LIKE wildcards).

$(body_brd)" "area:frontend"

issue "B5.1" "Loading states and progress" \
"Loading indicators for remote queries. Timeouts and QueryService errors surface as human-readable messages.

$(body_brd)" "area:frontend"

issue "B5.2" "Feature flags and fallbacks" \
"Toggle to select remote vs local/WASM per dataset. Safe fallbacks when QueryService unavailable.

$(body_brd)" "area:frontend"

# Track C – Testing and QA
issue "C1.1" "Backend unit tests" \
"Unit tests for API handlers (mocked engine/S3), config loading, schema validation. Good coverage; CI reports coverage.

$(body_brd)" "area:backend"

issue "C1.2" "Backend integration tests" \
"E2E tests with local S3-compatible store or fixtures. Verify /schema, /query/tuples, /query/cells on synthetic data.

$(body_brd)" "area:backend"

issue "C2.1" "UI tests for remote mode" \
"Browser tests: configure remote dataset, build simple pivot, assert HTTP calls to QueryService mock and expected UI values.

$(body_brd)" "area:frontend"

issue "C2.2" "Regression tests for local mode" \
"Ensure local/WASM behavior unchanged after remote mode changes.

$(body_brd)" "area:frontend"

issue "C3.1" "Backend load tests" \
"Representative query workloads with k6/Locust. Report p95 latency for day-scoped queries under target concurrency.

$(body_brd)" "area:backend"

issue "C3.2" "UI performance validation" \
"Validate Huey stays responsive (no main-thread blocking) under slow backend responses.

$(body_brd)" "area:frontend"

# Track D – Deployment and Operations
issue "D1.1" "Containerization of QueryService" \
"Production-ready Dockerfile for QueryService. Build in CI. Env vars for dataset config, S3, auth.

$(body_brd)" "area:infra"

issue "D1.2" "Environment configuration templates" \
"Example deployment manifests (Kubernetes/ECS) and env config templates under \`deploy/\`. Document S3 and auth setup per environment.

$(body_brd)" "area:infra"

issue "D2.1" "Metrics and dashboards" \
"Export metrics for org monitoring. At least one sample dashboard (latency, errors).

$(body_brd)" "area:infra"

issue "D2.2" "Logging setup" \
"Standardize structured log format. Document fields: request_id, user_id, dataset_id, date_range, status, duration_ms.

$(body_brd)" "area:infra"

issue "D2.3" "Operational runbooks" \
"Docs: deploy and rollback QueryService; diagnose S3/auth/schema failures and mitigation steps.

$(body_brd)" "area:infra"

echo "Done. Issues created in $REPO"

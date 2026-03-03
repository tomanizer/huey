## Huey Large-Scale OLAP – Business Requirements Document (BRD)

### 1. Executive Summary

Huey is currently a browser-only OLAP UI that uses DuckDB-WASM to read local and remote parquet/CSV files and provide interactive pivoting. This model works well for small to medium datasets but does not scale to a long-running, daily 50 GB parquet feed accumulated over multiple years and stored in S3 (or a similar object store).

This initiative will evolve Huey into a **large-scale OLAP UI over S3-backed parquet**, powered by a **server-side query service**. The UI and query model of Huey remain familiar, but heavy computation (scanning, filtering, aggregations, joins) moves to a backend engine that can exploit **partition pruning** and **predicate pushdown** to operate efficiently on large, time-partitioned datasets.

Primary business outcomes:

- Enable analysts and operations users to self-serve pivot analysis against multi-year 50 GB/day datasets, typically scoped to a single business day.
- Keep interaction times within acceptable bounds for exploration without overloading client machines.
- Provide a path to integrate Huey with existing data platforms (data lake/warehouse) over time.

### 2. Stakeholders and Users

- **Primary users**
  - **Data analysts / BI analysts**: build and iterate on pivots to understand daily operational metrics and trends.
  - **Product managers / business owners**: review daily and trend reports (often via saved views/dashboards).
  - **Operations teams (NOC, support, logistics, trading ops, etc.)**: perform checks on daily data (for anomalies at close-of-business).

- **Secondary users**
  - **Data engineers**: manage data pipelines into S3 parquet, ensure partitioning and schema health.
  - **Platform / SRE**: operate the backend query service, manage scaling, reliability, and cost.
  - **Security / compliance**: ensure access controls and logging are in place.

- **Stakeholder goals**
  - **Analysts & PMs**: fast, reliable pivots without needing SQL; ability to explore by day and over time.
  - **Ops**: predictable performance for daily checks; reduced need to pull large exports into spreadsheets.
  - **Data/platform teams**: single, robust service to expose S3 parquet analytically.
  - **Security/compliance**: central control of data access paths, auditable query history.

### 3. Data Domain and Scale

- **Data source**
  - Data is stored as **daily parquet datasets** per “condat” (conceptually a dataset or domain), for example:
    - `s3://bucket/condat_A/date=2026-03-01/part-*.parquet`
    - `s3://bucket/condat_A/date=2026-03-02/part-*.parquet`
    - `s3://bucket/condat_B/date=…`

- **Volume**
  - Per partition: approximately **50 GB per day per dataset**.
  - History: multiple years retained online, so cumulative TB-scale.
  - Access pattern:
    - Almost all interactive queries are scoped to **one day (COB)**.
    - Less frequent, heavier queries may span multiple days or weeks.

- **Schema**
  - Predominantly wide fact-style tables with:
    - Dimensions: ids, categories, geos, customer, product, etc.
    - Measures: numeric metrics to aggregate (counts, sums, etc.).
    - Time: partitioning column (for example, `date`), possibly finer-grained timestamps.
  - **Schema evolution**:
    - Additive columns expected over time.
    - Occasional type changes may happen; system should tolerate additive changes and flag incompatible changes clearly.

### 4. Scope

- **In scope**
  - Use Huey as the **primary UI and query builder** for:
    - Day-scoped pivoting on 50 GB partitions.
    - Occasional multi-day or range analysis.
  - Introduce a **server-side query service** that:
    - Executes pivot queries against S3 parquet.
    - Applies filter predicates and partition pruning.
    - Returns only the necessary headers (tuples) and cell windows as requested by Huey.
  - Support:
    - Pivoting on rows/columns.
    - Multiple measures (aggregates).
    - Filters on dimensions (and optionally simple filters on measures).
    - Totals/subtotals where feasible.
    - Export of results (subject to limits).
  - Provide:
    - A clear performance envelope for per-day usage.
    - Basic authentication/authorization.
    - Observability for operators.

- **Out of scope (initially)**
  - Full-blown dashboarding system (for example, scheduled reports, alerting).
  - Complex multi-join semantic layers and business logic beyond basic joins, unless specified.
  - Strong multi-tenant isolation beyond basic dataset-level access control (can be added later).
  - Fine-grained row-level security models; initially we assume dataset-level auth or simple predicates imposed by the backend.

### 5. Use Cases and User Journeys

#### 5.1 Daily close-of-business (COB) analysis

- **Actor**: Analyst or operations user.
- **Flow**:
  1. Open Huey and select a condat/dataset and a **COB date** (for example, `2026-03-01`).
  2. Huey fetches metadata (available fields and types) from the backend.
  3. User drags dimensions to rows/columns and measures to cells.
  4. Huey sends a day-scoped pivot query to the backend.
  5. Backend:
     - Restricts scan to the `2026-03-01` partition (~50 GB).
     - Applies filter predicates and aggregations.
     - Returns a window of tuples and cell values.
  6. Huey renders the pivot and allows scroll-based exploration (additional windows fetched transparently).
- **Success**: User sees first results quickly and can adjust pivots without timeouts or browser instability.

#### 5.2 Drill-down filtering

- **Actor**: Analyst.
- **Flow**:
  1. Start from a daily pivot.
  2. Add filters (for example, region, product, customer segment).
  3. Each filter update sends an updated query to the backend with additional predicates.
  4. Backend uses those predicates to reduce scanned data and compute new aggregates.
- **Success**: Additional filters refine results within acceptable latency without full table scans.

#### 5.3 Multi-day comparison

- **Actor**: Product manager or analyst.
- **Flow**:
  1. Select two or more days (for example, `2026-02-28` and `2026-03-01`).
  2. Define pivots that break down metrics by chosen dimensions and by date.
  3. Backend:
     - Scans the partitions for those days (for example, `2 × 50 GB`).
     - Computes per-date aggregates.
  4. Huey displays results, enabling side-by-side or over-time comparison.
- **Success**: Reasonable latency for 2–7 day ranges; beyond that, expectations may be more batch-like.

#### 5.4 Export for offline analysis

- **Actor**: Analyst.
- **Flow**:
  1. From a pivot view, user initiates export.
  2. User chooses export type: aggregated pivot data or underlying rows, and format (CSV or parquet).
  3. Backend:
     - Runs an export job that materializes results (with row/size limits).
     - Exposes a download URL or streams results.
  4. User downloads and opens in external tools.
- **Success**: Export works reliably within limits, without crashing browser memory.

#### 5.5 Saved views / deep links

- **Actor**: Any user.
- **Flow**:
  1. User configures a useful pivot (including date and filters) in Huey.
  2. Huey encodes this state (for example, URL fragment or server-side saved state).
  3. User shares the link.
  4. Another user opens the link; Huey restores query state and requests data for that date(s).
- **Success**: Saved views allow reproducible analyses without manual reconfiguration.

### 6. Functional Requirements

- **FR1 – Dataset and date selection**
  - FR1.1: Users can select a dataset/condat and a COB date (single day) as first-class parameters.
  - FR1.2: UI provides optional multi-day or range selection; system can warn about potentially heavy ranges.
  - FR1.3: Backend enforces that all queries include a date/partition constraint, unless explicitly allowed otherwise.

- **FR2 – Pivot definition and modification**
  - FR2.1: Users define **rows**, **columns**, and **measures** via a visual query builder.
  - FR2.2: Standard aggregations (for example, `count`, `sum`, `avg`, `min`, `max`) are supported; additional aggregates may be added according to engine capabilities.
  - FR2.3: Totals and subtotals per dimension are supported where the engine can compute them efficiently (for example, via `GROUPING SETS`).
  - FR2.4: Reordering and reconfiguring axes triggers new queries with minimal extra friction.

- **FR3 – Filtering**
  - FR3.1: Users can add filters on dimensions via a filter dialog (value picklists, range filters, LIKE/pattern filters).
  - FR3.2: Filter picklists are populated by backend queries that:
    - Are restricted to selected date(s).
    - Support pagination (value pages) for high-cardinality columns.
  - FR3.3: Filters are applied as predicates in backend queries (predicate pushdown).

- **FR4 – Query execution and results**
  - FR4.1: Huey sends queries to the backend in a structured format (for example, SQL or a model of axes and filters).
  - FR4.2: Backend executes queries and returns only the visible windows of:
    - Row tuples.
    - Column tuples.
    - Cell values.
  - FR4.3: Huey can request additional windows on scroll without re-running entire queries where possible.
  - FR4.4: Users can cancel long-running queries; backend should respond to cancellation.

- **FR5 – Exports**
  - FR5.1: From any current pivot configuration, users can request an export of:
    - Aggregated pivot results.
    - Underlying detailed rows (with row caps).
  - FR5.2: Backend may perform exports asynchronously and provide a download link.
  - FR5.3: Export size limits and formats (CSV, parquet) are configurable.

- **FR6 – Metadata and schema**
  - FR6.1: Huey retrieves field lists, types, and basic stats for each dataset and date range from the backend.
  - FR6.2: Fields include information required for pivoting (for example, `is_dimension`, `is_measure`).
  - FR6.3: Schema changes are handled gracefully:
    - Missing fields for older dates result in clear UX (for example, disabled fields or warnings).

- **FR7 – Access control and security**
  - FR7.1: Users authenticate to the backend via a configured identity mechanism.
  - FR7.2: Backend enforces at least dataset-level permissions (who can query which condat).
  - FR7.3: Optionally, simple predicate-based security (for example, restrict to certain regions) can be applied server-side.

- **FR8 – Observability and admin**
  - FR8.1: Operators can see metrics on:
    - Request counts and latency distribution per endpoint.
    - Error and timeout rates.
  - FR8.2: System provides logs of query requests (with minimal necessary details for debugging).
  - FR8.3: Health endpoints indicate readiness and liveness of the backend.

### 7. Non-Functional Requirements

- **Performance**
  - NFR1.1: For day-scoped queries on 50 GB partitions, **p95 latency for typical pivot/filter interactions should be under 3–5 seconds**.
  - NFR1.2: Heavy or atypical queries (for example, wide multi-day ranges) may exceed that bound, but the system must remain stable and provide clear progress and feedback.
  - NFR1.3: Filter picklist queries for high-cardinality dimensions should respond within approximately 2–4 seconds per page.

- **Scalability**
  - NFR2.1: System must scale to multi-year history (for example, 3–5 years of 50 GB/day) without architectural changes.
  - NFR2.2: System should support a moderate number of concurrent users (exact number to be refined) without severe performance degradation.
  - NFR2.3: Backend components are horizontally scalable or can be vertically scaled as load grows.

- **Reliability and availability**
  - NFR3.1: Backend should target high availability suitable for business-hours usage (exact SLA to be refined).
  - NFR3.2: Graceful degradation:
    - Clear error messages for failed queries.
    - Automatic retry on transient errors where safe.
  - NFR3.3: No single user query should be able to starve the system indefinitely; timeouts and resource limits are required.

- **Security and compliance**
  - NFR4.1: All traffic between Huey and backend must be secured (for example, TLS).
  - NFR4.2: Authentication and authorization mechanisms must plug into the organization’s identity stack.
  - NFR4.3: Auditing:
    - Capture which user executed which query on which dataset and when.
    - Retain audit logs for a configurable period.

- **Usability**
  - NFR5.1: The pivot-building experience remains as close as possible to current Huey.
  - NFR5.2: The system indicates clearly when queries are running, completed, cancelled, or failed.
  - NFR5.3: Reasonable defaults (for example, default COB date, sample saved views).

- **Operability**
  - NFR6.1: Configuration of dataset locations, S3 bucket names, and partitioning patterns should be declarative and version-controlled.
  - NFR6.2: Deployment and rollback are automated with minimal downtime.

### 8. Assumptions and Constraints

- A suitable object store (for example, S3) already hosts the parquet data.
- Data is partitioned by date (or can be restructured accordingly).
- Organization is open to running a new backend service adjacent to Huey.
- Huey may continue to support its legacy in-browser mode for small or ad-hoc local files as a separate path.

### 9. Risks

- Underestimated query complexity leading to slower-than-expected performance on some pivots.
- Users may create expensive multi-day or unbounded queries; requires guardrails and clear messaging.
- Long-term schema evolution could complicate cross-year comparisons.
- Cost escalation if queries are not well constrained by partitions and predicates.

### 10. Success Metrics

- Time from daily dataset availability to first interactive analysis.
- p95 latency for representative daily pivot workloads.
- Reduction in ad-hoc offline exports / external tool use for daily data.
- Number of active Huey users working on large datasets over time.
- Fewer incidents of browser crashes or out-of-memory errors during analysis.


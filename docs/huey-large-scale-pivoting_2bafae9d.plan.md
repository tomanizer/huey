---
name: huey-large-scale-pivoting
overview: Define business, technical, and architectural foundations to evolve Huey into a server-side powered OLAP UI that can efficiently pivot over multi-year 50GB-per-day parquet datasets, primarily queried per-day, with predicate pushdown against S3 or an equivalent data lake.
todos:
  - id: draft-brd
    content: Write the full Huey large-scale OLAP BRD based on this outline, filling in concrete user journeys, detailed functional and non-functional requirements, and explicit success metrics.
    status: completed
  - id: draft-tech-spec
    content: Derive a detailed Technical Specification from the BRD, including precise backend API contracts, query model translation rules, data partitioning approach, and non-functional constraints.
    status: completed
  - id: design-architecture
    content: Create a Technical Architecture document describing system components, deployment topology, data flows, and integration points between Huey, QueryService, query engine, and S3.
    status: completed
  - id: plan-implementation-phases
    content: Break the architecture into incremental, testable implementation phases with epics and stories suitable for a backlog (backend foundations, Huey integration, performance hardening, rollout).
    status: completed
isProject: false
---

# Huey Large-Scale OLAP Evolution

## Goals

- **Business grounding**: Capture a clear Business Requirements Document (BRD) for "Huey as a large-scale OLAP UI" over S3-backed parquet (50 GB per day, multi-year history, queries mostly scoped to a single day/partition).
- **Technical grounding**: Derive a Technical Specification that translates the BRD into detailed behavior, interfaces, and constraints (including server-side pivoting and predicate pushdown).
- **Architecture foundation**: Design a Technical Architecture that introduces a backend query service while preserving Huey’s UX and query model.
- **Implementation roadmap**: Break down work into small, testable packages for incremental delivery.

## High-Level Context

- **Current state (assumed)**:
  - Huey is a browser-only app using DuckDB-WASM for all query execution.
  - It loads parquet/CSV/etc. directly from local files or HTTP URLs.
  - All pivoting, aggregation, and filtering happens client-side in the browser.
- **Target state**:
  - Huey remains the **primary UI and query model**, but heavy computation runs on a **server-side query engine** over S3 parquet (or equivalent object storage).
  - Most user interactions are **constrained to a single day’s 50GB partition**, with multi-year data kept online and queryable.
  - Predicate pushdown and partition pruning minimize data scanned per query.

## BRD Outline (Business Requirements Document)

- **1. Executive Summary**
  - Problem statement: current browser-only Huey struggles with very large datasets (50GB/day * years) and remote parquet.
  - Vision: Huey as an interactive OLAP UI for large S3-backed datasets, retaining its UX while adding server-side power.
  - Primary business outcomes: faster analyst workflows, self-serve pivoting over large history, lower desktop resource usage.
- **2. Stakeholders and Users**
  - Primary users: data analysts, product managers, operations users exploring metrics by day.
  - Secondary users: data engineers (managing data and performance), platform/SRE teams (operating backend).
  - Stakeholder goals: reliability, predictable performance, low friction onboarding, secure data access.
- **3. Data Domain and Scale**
  - Data location: S3 (or compatible object store) containing daily parquet partitions.
  - Volume characteristics:
    - ~50 GB per day per dataset (condat), for several years.
    - Typical queries scoped to a single day; occasional multi-day or range queries.
  - Data model assumptions:
    - Time-based partitioning (e.g. `date` or `dt` column) for pruning.
    - Schema evolution is rare but possible; must handle additive columns and type changes within reason.
- **4. Use Cases and User Journeys**
  - Ad-hoc pivoting for a chosen day (rows, columns, measures, filters).
  - Metric comparison between two or more days.
  - Filter drill-down (from global KPIs to detailed dimensional slices).
  - Export of pivot results (CSV/parquet) for a given day or filtered subset.
  - Saving and sharing queries / dashboards referencing specific date partitions.
- **5. Functional Requirements**
  - **Data access & selection**
    - Users can select a **date (or date range)** as a first-class concept.
    - System automatically scopes queries to the selected partition(s).
  - **Pivoting & filtering**
    - Users can define rows/columns/measures similar to current Huey.
    - Filters (including on dimensions and measures) are applied server-side with predicate pushdown.
    - Support for multi-level hierarchies, totals/subtotals, and drill-down within the selected date(s).
  - **Query management**
    - Each pivot/filter action triggers a server-side query; Huey shows progress and handles cancellations.
    - Query configurations (including date scope) can be saved and reloaded.
  - **Exports**
    - Users can export current pivot views or underlying row sets up to defined limits.
  - **Operations & observability**
    - Operators can monitor query volume, latency, failures, and resource usage.
- **6. Non-Functional Requirements**
  - **Performance** (defaults we will refine if you choose later):
    - Typical per-day pivot/filter operations should complete in **< 3–5 seconds p95**.
    - UI must remain responsive even for longer-running queries (spinners, cancel, no browser crashes).
  - **Scalability**
    - Must support **multi-year history** at 50GB/day with predictable performance via partition pruning.
    - Horizontal scalability at backend tier (stateless query API plus engine that can scale up/out).
  - **Reliability & availability**
    - Clear error handling for backend failures; graceful degradation in UI.
  - **Security & access control** (high-level for now):
    - Authentication to backend.
    - Authorisation model that can restrict datasets and possibly row/column access by user.
  - **Usability**
    - UX should feel as close as possible to current Huey, with clear indication when a query is running or has completed.
- **7. Constraints and Assumptions**
  - Backend stack is not yet fixed; we assume a pragmatic choice (e.g. DuckDB-native service or similar) and will refine in the Technical Spec.
  - Data is already in or can be made available in well-structured parquet partitions in S3.
  - Network between Huey and backend is reasonably low-latency and reliable.
- **8. Success Metrics**
  - Time-to-first-insight for analysts on large daily parquet drops.
  - Reduction in browser crashes / memory exhaustion incidents.
  - Adoption metrics: number of daily active users/queries.
  - Performance metrics: p95 latency for representative queries, cost per query.
- **9. Risks and Open Questions**
  - Risk: ambiguous performance expectations on older/larger partitions (multi-year range scans).
  - Risk: cost blow-ups if analysts frequently query wide multi-year ranges.
  - Open questions to refine later: exact SLAs, concurrency expectations, stack constraints, security/compliance specifics.

## Technical Specification Outline

- **1. Overview and Scope**
  - Map BRD use cases to concrete components and services.
  - Explicitly state in-scope: server-side query API, S3 parquet integration, Huey client integration.
- **2. Data Model & Partitioning**
  - Logical schema(s) for supported datasets, including partitioning columns.
  - Supported data types, handling of schema evolution.
  - Mapping between Huey fields and backend schema.
- **3. Backend API Design**
  - Core endpoints (REST/JSON as a default assumption, can be adjusted later):
    - `POST /query/tuples` – fetch row/column headers window for given axes, filters, and date scope.
    - `POST /query/cells` – fetch cell metrics for a rectangular window (rows x columns) for given axes and filters.
    - `POST /query/picklist` – fetch distinct values (with paging) for filter UIs.
    - `POST /export` – request export jobs and obtain download URLs.
  - Request/response schemas:
    - Common envelope: dataset identifier, date or date-range, query model (rows/cols/measures/filters), pagination or cursor state.
    - Error formats.
- **4. Query Model & Translation**
  - Decide where SQL is generated:
    - Option A (default): Huey continues to generate SQL; backend executes it with limited validation.
    - Option B (future): Huey sends a structured query model; backend generates SQL and applies policy.
  - Specification of how filters, aggregations, totals, and drill-down map to backend queries.
  - Predicate pushdown rules: always include partition/date filters and other selective predicates.
- **5. Execution Engine and Storage Integration**
  - Chosen engine (default assumption: native DuckDB or similar columnar engine):
    - How it connects to S3 and configures caching.
    - How daily partitions are discovered and pruned.
  - Handling of large result sets (e.g. server-side limits, partial fetch, streaming).
- **6. Performance & Resource Management**
  - Query time limits and size limits.
  - Concurrency handling and backpressure behavior.
  - Caching strategies (e.g. caching frequently accessed partitions or popular aggregate results).
- **7. Security & Multi-Tenancy**
  - Authentication flow between Huey and backend (e.g. JWT, OAuth2, mTLS, or reverse proxy auth).
  - Authorisation model: dataset- and possibly row-level filters.
  - Audit logging of queries.
- **8. Client Integration Changes (Huey)**
  - New datasource type (e.g. `REMOTE`) and configuration UI for binding to backend datasets.
  - Request orchestration: how Huey decides when to hit backend vs any local/WASM mode.
  - Error handling and user feedback.
- **9. Observability & Operations**
  - Metrics, logs, and tracing requirements for backend.
  - Health checks and readiness probes.
- **10. Testing Strategy**
  - Unit/contract tests for backend API.
  - Integration tests using synthetic 50GB-per-day samples.
  - Performance tests with representative pivot/filter workloads.

## High-Level Architecture (for later detailed diagram)

We will elaborate this in the Technical Architecture document, but the target shape is:

```mermaid
flowchart LR
  userBrowser[UserBrowser] --> hueyUi["Huey UI (pivot, filters)"]
  hueyUi --> backendApi["QueryService API"]
  backendApi --> queryEngine["QueryEngine (e.g. DuckDB native)"]
  queryEngine --> objectStore["S3 Parquet Store"]
```



Key properties:

- Huey remains a static client app but now talks to `QueryService` for data.
- `QueryService` encapsulates all S3 access and heavy computation.
- Partition pruning and predicate pushdown live in `QueryEngine` configuration and query planning.

## Implementation Roadmap (Post-Spec/Architecture)

- **Phase 1 – Documentation & Design**
  - Finalize BRD (based on outline above, iterating with you).
  - Draft full Technical Specification with concrete API contracts and chosen engine/stack.
  - Produce detailed Technical Architecture doc (component diagrams, deployment topology, data flows).
- **Phase 2 – Backend Foundations**
  - Implement minimally viable `QueryService`:
    - Single dataset support.
    - Day-scoped queries with simple pivoting.
    - S3 parquet integration.
  - Add observability and basic auth.
- **Phase 3 – Huey Integration**
  - Add `REMOTE` datasource type in Huey and bind to `QueryService` endpoints.
  - Wire existing pivot/filter UI to call backend instead of WASM for selected datasets.
  - Preserve current UX while ensuring graceful error handling.
- **Phase 4 – Scale, UX, and Hardening**
  - Optimize backend performance and caching for common patterns.
  - Add multi-day range queries and comparison flows.
  - Extend exports and saved queries.
  - Do load/perf and failure-mode testing.
- **Phase 5 – Rollout & Feedback**
  - Pilot with selected datasets and users.
  - Collect performance and usability feedback.
  - Iterate BRD/Spec/Architecture with learnings.


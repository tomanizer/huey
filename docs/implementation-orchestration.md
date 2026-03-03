# Implementation Orchestration – Agent Workflow

This document instructs an **orchestrator agent** that oversees the Huey Large-Scale OLAP implementation. The orchestrator assigns GitHub issues to **sub-agents** (implementers), then a **reviewer agent** reviews the resulting PRs and merges them when they are correct and all tests pass.

## Roles

| Role | Responsibility |
|------|----------------|
| **Orchestrator** | Chooses the next issue(s) to work on (respecting dependencies), assigns work to sub-agents, ensures one issue → one PR, and triggers the reviewer after a PR is opened. |
| **Sub-agent (implementer)** | Implements a single issue: creates a branch, writes code and tests, opens a PR that references the issue (e.g. "Fixes #N"). |
| **Reviewer agent** | Reviews the PR (code quality, alignment with BRD/Tech Spec/Architecture, tests). Approves and merges only if criteria are met; otherwise requests changes. |

## Implementation Order (Issue → Phase)

Follow this order so dependencies are respected. Each line is one or more GitHub issues; implement in the order listed.

### Phase 1 – Backend skeleton

1. **#1 [A1.1]** – Create QueryService skeleton (Python FastAPI app under `server/` or `backend/query-service/`, health endpoints, config loader, logging).
2. **#2 [A1.2]** – CI pipeline and basic checks (build, lint, unit tests).
3. **#31 [D1.1]** – Containerization (Dockerfile for QueryService).

### Phase 2 – Schema and data plumbing

4. **#3 [A2.1]** – Dataset configuration loader.
5. **#4 [A2.2]** – Implement `GET /schema`.
6. **#5 [A3.1]** – Analytical engine integration (DuckDB in-process).
7. **#6 [A3.2]** – S3 connectivity and sample partition read.

### Phase 3 – Core query endpoints

8. **#7 [A4.1]** – Implement `POST /query/tuples` (basic).
9. **#8 [A4.2]** – Implement `POST /query/cells` (basic).
10. **#9 [A5.1]** – Implement `POST /query/picklist`.

Use **#25 [C1.1]** and **#26 [C1.2]** as you implement: add unit tests and integration tests for each endpoint.

### Phase 4 – Huey integration (can start after #4 and #7 exist)

11. **#16 [B1.1]** – Remote datasource configuration model.
12. **#17 [B1.2]** – RemoteDatasource abstraction (fetch to QueryService).
13. **#18 [B2.1]** – Attribute UI backed by `/schema`.
14. **#19 [B3.1]** – Tuple fetching via `/query/tuples`.
15. **#20 [B3.2]** – Cell fetching via `/query/cells`.
16. **#21 [B4.1]** – Filter picklists via `/query/picklist`.
17. **#22 [B4.2]** – Filter application and query mapping.
18. **#23 [B5.1]** – Loading states and progress.
19. **#24 [B5.2]** – Feature flags and fallbacks.

### Phase 5 – Exports, limits, auth, observability

20. **#10 [A5.2]** – Implement `POST /export` (MVP).
21. **#11 [A6.1]** – Date-range support and guardrails.
22. **#12 [A6.2]** – Timeouts and resource limits.
23. **#13 [A6.3]** – Observability and metrics.
24. **#14 [A6.4]** – Authentication and authorization (initial).
25. **#32 [D1.2]** – Environment configuration templates.
26. **#33 [D2.1]** – Metrics and dashboards.
27. **#34 [D2.2]** – Logging setup.
28. **#35 [D2.3]** – Operational runbooks.

### Phase 6 – Testing and performance

29. **#25 [C1.1]** – Backend unit tests (can be done earlier; ensure coverage as endpoints are added).
30. **#26 [C1.2]** – Backend integration tests.
31. **#27 [C2.1]** – UI tests for remote mode.
32. **#28 [C2.2]** – Regression tests for local mode.
33. **#29 [C3.1]** – Backend load tests.
34. **#30 [C3.2]** – UI performance validation.

Issue numbers above assume the order created by `scripts/create-olap-issues.sh` (e.g. #1 = A1.1, #16 = B1.1). If your issue numbers differ, map by issue title prefix (e.g. `[A1.1]`, `[B1.1]`).

---

## Orchestrator Instructions

### 1. On start or when ready for next work

- Determine the **next open issue** that is unassigned and whose dependencies are done (i.e. earlier issues in the list above are merged or not applicable).
- If multiple issues can run in parallel (e.g. backend vs frontend), you may assign more than one, each to a separate sub-agent.

### 2. Assigning work to a sub-agent

For each issue chosen:

- **Branch name:** `issue-<N>-<slug>` (e.g. `issue-1-a1-1-skeleton`), where `<N>` is the GitHub issue number and `<slug>` is a short kebab-case label (e.g. `a1-1-skeleton`).
- **Instructions to sub-agent** (provide these in the agent prompt or task description):

  - **Objective:** Implement GitHub issue #&lt;N&gt; (title: [A1.1] Create QueryService skeleton). Open a single PR that fulfils the issue and references it (e.g. "Fixes #1" in the PR description).
  - **Context:** Read and follow:
    - `docs/huey-large-scale-olap-tech-spec.md` for API contracts and behaviour.
    - `docs/huey-large-scale-olap-architecture.md` for component layout and backend stack (Python, FastAPI, DuckDB).
    - The issue body on GitHub for acceptance criteria.
  - **Constraints:**
    - One issue per PR. Do not mix multiple issues in one PR.
    - Backend code lives under `server/` (or `backend/query-service/` as per architecture). Use Python 3.x, FastAPI, and DuckDB.
    - Ensure existing tests still pass; add or update tests as required by the issue.
  - **Deliverables:**
    - Branch created from default branch (e.g. `dev`).
    - Code changes, tests, and any config updates (e.g. CI, Dockerfile) as needed.
    - PR opened **in the fork** (e.g. `tomanizer/huey`), not in the upstream repo. Use `gh pr create --repo tomanizer/huey --base dev ...` so the PR is created in the correct repo. Description must include "Fixes #&lt;N&gt;" and a short summary.

- Invoke the sub-agent (e.g. via task runner or agent framework) with the above and the repo path. Wait for the sub-agent to open the PR (or report failure).

### 3. After a PR is opened

- Trigger the **reviewer agent** with:
  - The PR URL or branch name.
  - Instructions (see Reviewer Agent Instructions below).
- Do **not** merge the PR yourself; only the reviewer agent approves and merges (or requests changes).

### 4. After reviewer merges or requests changes

- If **merged:** Mark the issue as done (e.g. close the issue via the PR link). Proceed to the next issue(s) from the implementation order.
- If **changes requested:** Re-assign the same issue to a sub-agent (or the same one) with the reviewer’s feedback. The sub-agent should update the existing PR. Then trigger the reviewer again.

### 5. Handling failures

- If the sub-agent fails to open a PR (e.g. build or tests fail): Log or report the failure, optionally re-assign the issue with clearer instructions or a narrower scope. Do not advance to the next issue until the current one is either merged or explicitly deferred.
- If the reviewer rejects the PR: Loop back to step 4 (re-assign with feedback). After a fixed number of rounds (e.g. 2–3), escalate or flag for human review.

---

## Reviewer Agent Instructions

Provide these instructions whenever the reviewer agent is invoked for a PR.

### 1. Scope of review

- **Correctness:** Implementation matches the issue description and acceptance criteria. For API endpoints, behaviour matches `docs/huey-large-scale-olap-tech-spec.md`.
- **Architecture:** Backend follows the chosen stack (Python, FastAPI, DuckDB) and layout (e.g. `server/` or `backend/query-service/`). No unnecessary divergence from `docs/huey-large-scale-olap-architecture.md`.
- **Quality:** Code is readable, no obvious bugs, error paths and edge cases considered. No commented-out dead code or temporary hacks left in.
- **Tests:** New or updated code is covered by tests where appropriate. All tests (unit and, if applicable, integration) pass in CI.
- **One issue per PR:** The PR description references exactly one issue (e.g. "Fixes #1"). The diff does not implement unrelated issues.

### 2. Merge criteria (all must be satisfied)

- CI is green (build, lint, tests).
- Review checklist above is satisfied; no blocking comments.
- At least one approval (from the reviewer agent or a human, as per repo policy).
- No merge conflicts with the target branch.

### 3. Actions

- If all criteria are met: Approve the PR and merge it (squash or merge commit per repo policy). Close the linked issue if not auto-closed.
- If any criterion fails: Request changes. In the review comment, list what must be fixed (with file/line references if helpful). Do not merge until the author has pushed fixes and criteria are met.

### 4. What the reviewer must not do

- Do not implement new features or edit code in the PR; only review and approve/request changes.
- Do not merge if CI is red or if the "One issue per PR" rule is violated.

---

## Reference: Key Repo Paths and Docs

- **Backend (QueryService):** `server/` or `backend/query-service/` (Python, FastAPI, DuckDB).
- **Huey (frontend):** `src/` (existing JS; add RemoteDatasource and wiring here).
- **Docs:**  
  - `docs/huey-large-scale-olap-brd.md`  
  - `docs/huey-large-scale-olap-tech-spec.md`  
  - `docs/huey-large-scale-olap-architecture.md`
- **Issue list:** GitHub Issues in the fork (e.g. `tomanizer/huey`), created by `scripts/create-olap-issues.sh`.

---

## Summary Checklist for Orchestrator

- [ ] Pick next issue(s) from the implementation order; ensure dependencies are merged.
- [ ] Assign each issue to a sub-agent with: issue number, branch name, context docs, and deliverables.
- [ ] When a PR is opened, invoke the reviewer agent with the PR and reviewer instructions.
- [ ] If merged: close issue, advance to next. If changes requested: re-assign with feedback and re-run reviewer.
- [ ] Do not merge PRs yourself; only the reviewer agent (or human) merges.

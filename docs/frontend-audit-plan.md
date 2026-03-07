# Frontend Audit & Improvement Plan

Generated: 2026-03-07

## Current State Assessment

### Architecture
- Vanilla JS app (no framework) using DuckDB WASM as an in-browser OLAP engine
- Custom EventEmitter-based state management via QueryModel
- URL hash routing with Base64-encoded state serialization
- Settings persisted to localStorage
- ~62 JS files, ~19K lines of JS in src/, plus a 2,206-line monolithic index.html

### Key Strengths
- Zero runtime dependencies -- lightweight, fast to load
- Solid data layer: CellSet/TupleSet with LRU caching, lazy loading
- Good event architecture (EventEmitter + EventBuffer debouncing)
- i18n support (3 languages)
- PostMessage API for iframe embedding
- Remote mode support for server-backed queries

### Critical Problems

| Problem | Severity | Evidence |
|---------|----------|----------|
| 2 failing unit tests | HIGH | pivot-table-ui-lifecycle and postmessage-interface tests fail on current main |
| 49 ESLint warnings | MEDIUM | Including a complexity-59 function in SQLHelper.js |
| 22% statement coverage | MEDIUM | Many modules at 0% coverage |
| Monolithic PivotTableUi.js | MEDIUM | 2,568 lines -- rendering, scrolling, resizing, context menus all in one file |
| Monolithic index.html | MEDIUM | 2,206 lines of markup for all dialogs, templates, menus |
| Global singletons | LOW-MED | Components access dependencies through implicit globals |
| Bug: filter dialog persists wrong value | HIGH | Issue #381 -- search shows GOOG but applies AAPL |

## Open Issues Summary (24 issues)

| Category | Issues | Notes |
|----------|--------|-------|
| Active bug | #381 | Filter dialog state corruption -- highest priority |
| Wave 1: Blockers & Security | #316 (tracker), 11 child issues | Partially complete, critical fixes |
| Wave 2: Testing Foundation | #317 (tracker), 3 remaining | 3 of 6 done |
| Wave 3: Frontend Maintainability | #318 (tracker), 11 child issues | Core focus of this audit |
| Wave 4: API/Backend Hardening | #319 (tracker), 7 child issues | Backend-focused |
| Wave 5: Expansion | #320 (tracker) | Multi-database, long-horizon |
| Test coverage | #330, #329 | Umbrella for coverage gaps |
| Multi-database epic | #162, #164-170 | Future expansion, defer |
| Backend perf | #103, #172 | Not frontend-relevant |

## Open PRs Assessment (19 PRs)

### Merge Now (fix tests, clear debt)

| PR | Title | Rationale |
|----|-------|-----------|
| #378 | Stabilize flaky frontend async tests | Directly fixes the 2 failing unit tests. Small, safe change. Merge first. |
| #359 | Enforce frontend lint warning budget | Adds --max-warnings gate + burns down some PivotTableUi warnings. Low risk. |

### Merge Soon (high value, review feedback addressed)

| PR | Title | Rationale |
|----|-------|-----------|
| #380 | Harden e2e helpers and accessibility | Fixes a11y issues and test helpers. Has review comments -- address those, then merge. |
| #371 | Optimize TupleSet LRU eviction | Removes O(n) full-map scan per eviction. Real perf win. |
| #372 | Add CellSet size-based eviction coverage | Test coverage for existing logic. Low risk. |
| #370 | Add max-cache-size LRU eviction coverage | Same -- test coverage, no production code changes. |

### Merge After Careful Review (architectural changes)

| PR | Title | Rationale |
|----|-------|-----------|
| #366 | Refactor PivotTableUi into sub-modules | High-value decomposition but Copilot flagged 3 bugs (tuple ID, division-by-zero, totals detection). Fix those first. |
| #367 | AppContext service registry (DI) | Good architectural direction but big surface area. Needs thorough testing. |
| #368 | Extract HTML partials from index.html | Has 8 review issues (broken a11y, malformed HTML, missing rel attrs). Fix first. |
| #365 | Optimize PivotTableUi rendering | Has a double-append bug noted in review. Fix before merging. |

### Defer / Close

| PR | Title | Rationale |
|----|-------|-----------|
| #377 | Semantic field names in /query/cells | Backend API change -- Wave 4, not frontend priority |
| #374 | Add frontend audit roadmap doc | Will be superseded by this plan |
| #373 | DuckDB avatar in About dialog | Cosmetic, low priority |
| #364 | Performance metrics in UI | Good feature but depends on #366 refactor landing first |
| #363 | Cursor/keyset pagination | Backend change, Wave 4 |
| #362 | Harden dimension prewarm | Backend, Wave 2 |
| #361 | Document Ruff command | Backend docs, trivial |
| #360 | Playwright remote-mode coverage | Backend-dependent, Wave 2 |

## Recommended Implementation Order

### Phase 1: Stabilize (do now)

1. Fix #381 -- Filter dialog state bug. User-facing data-integrity bug.
2. Merge PR #378 -- Fixes the 2 failing unit tests (async timing).
3. Merge PR #359 -- Enforces lint budget at 47 warnings.
4. Merge PRs #370, #372 -- Test coverage for cache eviction (no prod changes).

### Phase 2: Performance & Quality (next)

5. Merge PR #371 -- TupleSet LRU optimization (real perf fix).
6. Merge PR #380 -- After addressing review feedback (a11y + test helpers).
7. Address #330 sub-issues -- Push statement coverage from 22% toward 40%+.

### Phase 3: Architecture (after stabilization)

8. Fix and merge PR #366 -- PivotTableUi decomposition (fix the 3 bugs first). Single highest-leverage refactor.
9. Fix and merge PR #368 -- HTML partials extraction (fix the 8 review issues).
10. Merge PR #367 -- AppContext DI pattern, after #366 lands.
11. Merge PR #365 -- Rendering optimization, after #366 lands.

### Phase 4: Features (after architecture)

12. PR #364 -- Performance metrics (builds on #366 refactor).
13. Close remaining Wave 3 child issues as addressed.
14. Begin Wave 4 backend hardening.

### Defer / Close for Now

- Issues #162, #164-170 (multi-database epic) -- Wave 5, long-horizon. Keep open but don't prioritize.
- Issues #103, #172 -- Backend perf, not frontend. Keep open.
- PR #374 -- Close (superseded by this plan).
- PR #373 -- Close (cosmetic, not worth review cycles).
- PR #361 -- Merge if trivial (just docs), otherwise close.
- Issues #310, #312 -- Close as duplicates of #309 and #311 respectively.

## Summary

| Action | Count |
|--------|-------|
| PRs to merge now | 4 (#378, #359, #370, #372) |
| PRs to merge soon | 3 (#371, #380, #366 after fixes) |
| PRs to merge after architecture | 4 (#368, #367, #365, #364) |
| PRs to close/defer | 5 (#374, #373, #361, #377, #363) |
| Issues to close as duplicates | 2 (#310, #312) |
| Top priority bug to fix | #381 (filter dialog) |
| Top priority refactor | #366 (PivotTableUi decomposition) |

Critical path: fix failing tests (#378) -> fix filter bug (#381) -> enforce lint budget (#359) -> decompose PivotTableUi (#366) -> extract HTML (#368) -> introduce DI (#367)

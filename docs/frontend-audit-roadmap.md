# Frontend Audit Improvement Roadmap

This document captures the current frontend audit findings for `src/` and the recommended order for addressing them. It mirrors the issue index used to track the work in GitHub so contributors can find the roadmap from inside the repository.

## Overall assessment

| Area | Score | Notes |
|------|-------|-------|
| Architecture | 7/10 | Clean ESM structure and feature directories, but some god-objects and globals remain. |
| Implementation | 6/10 | Functional overall, but `eval()`, `debugger` statements, and `innerHTML` usage need follow-up. |
| Testing | 4/10 | Unit and E2E coverage exists, but audit follow-up should continue expanding it. |
| Accessibility | 3/10 | Basic semantics exist, but complex interactions still need keyboard and ARIA improvements. |
| Security | 6/10 | Good `postMessage` origin checks, but `eval()` and HTML injection risks require attention. |
| Project health | 6/10 | Modern tooling is in place, but frontend maintenance debt is accumulating. |

## Recommended working order

### Phase 1: Critical security and quality

1. **#247** — Remove `eval()` calls in `SettingsDialog`
2. **#250** — Remove `debugger` statements and clean up console logging
3. **#254** — Sanitize `innerHTML` usage and prevent XSS vectors

### Phase 2: Testing foundation

4. **#252** — Add unit tests for core untested modules
5. **#256** — Expand Playwright E2E test coverage

### Phase 3: Code quality

6. **#260** — Add ESLint rules *(depends on #247 and #250)*
7. **#257** — Improve error handling *(depends on #250)*
8. **#263** — Remove incomplete feature stubs and dead code *(depends on #250 and #260)*

### Phase 4: Architecture

9. **#255** — Split god-object modules *(depends on #252)*
10. **#258** — Extract `index.html` templates *(depends on #255)*
11. **#264** — Reduce global state *(depends on #252 and #255)*

### Phase 5: Polish

12. **#261** — Accessibility improvements
13. **#267** — Add JSDoc type annotations
14. **#268** — Cache size limits for memory management
15. **#269** — Convert `RemoteQueryAdapter` IIFE to an ES6 class

## Dependency guide

```text
#247 (eval) ──────────┐
#250 (debugger) ──────┼──→ #260 (ESLint) ──→ #263 (dead code)
#254 (innerHTML) ─────┘         │
                        ↓
                      #257 (error handling)

#252 (unit tests) ────────→ #255 (split modules) ──→ #258 (extract HTML)
       │                          │
       └──────────────────→ #264 (global state)

#256 (E2E tests) ────────→ #261 (accessibility)

#268 (cache) and #269 (IIFE) are independent, but are easiest to tackle after the testing and architecture work above.
```

## Audit stats

- **54** source files
- **22,815** lines of frontend code
- **9** files with unit tests at audit time
- **38** unit tests and **~20** E2E tests at audit time
- **8** `eval()` calls to remove
- **2** production `debugger` statements
- **50+** console statements to review
- **30+** `innerHTML` assignments to review
- **4** frontend modules over 1000 lines each

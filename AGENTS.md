# Hopya Development

Read `TODO.md`, `docs/architecture.md`, and the relevant implementation before editing.

- Keep `TODO.md` current: record changes, problems, verification evidence, and remarks. Move completed work out of open work; never call an untested integration production-ready.
- TypeScript throughout. AdonisJS owns the API and security boundary. Astro owns pages; React islands own interactive task views. Effect handles fallible integration workflows.
- All task access is workspace-scoped and permission-checked. Never trust workspace IDs, resource IDs, client roles, agent arguments, or model output.
- Never return password hashes, token hashes, provider keys, or raw secrets. No public default accounts, anonymous uploads, silent telemetry, or mandatory cloud dependency.
- Browser auth uses HttpOnly cookies and same-origin mutation checks. Programmatic tokens are hashed at rest and revocable. Audit changes without logging secrets or entire AI prompts.
- Keep integrations optional. AI actions require explicit human confirmation for mutations. OIDC identities bind to issuer and subject, not unverified email.
- Use parameterized SQL, transactions for mutations plus audit entries, bounded input sizes, and validated storage object keys.
- Preserve accessible keyboard alternatives and mobile layouts for all views. Do not replace real functionality with demo data.
- Hierarchy moves must stay workspace-scoped, reject cycles and subtree depth overflow, preserve contents and commit with audits. Rendering limits must remain explicit and must not truncate full-dataset search, totals or exports.
- Cursor pages must check current permissions and bind position to workspace/filters, not act as credentials. Bulk readers use separate bounded-lifetime SQLite snapshots, recheck access before chunks, and release connections/slots on every exit. Preserve complete bulk JSON shapes and never present an interrupted stream as success.
- Run `npm run check` and applicable integration tests. Document unavailable external service checks explicitly.
- Never run browser tests (any Playwright run, full or focused, container or local) unless the owner explicitly asks for them in the current request. Verify UI work with typecheck, unit tests, and API-layer tests instead; note unverified browser behavior in `TODO.md`.
- Keep tests risk-based and minimal. Before adding a test, check existing coverage and name the distinct failure it protects: a core workflow, permission boundary, data-integrity rule, or demonstrated regression. Prefer extending the closest test over a new suite.
- Test validation/business rules at the API or unit layer; use browser tests for interaction, accessibility and draft recovery, and a small live happy path for integration wiring. Do not repeat the same assertions across all layers, field types, shared views, viewport sizes or browsers without a concrete distinct risk. Avoid cosmetic-copy checks, fixture-only tests and exhaustive input permutations. Remove superseded coverage instead of accumulating it; never remove a unique security or data-loss regression just to reduce counts.
- Do not commit generated output, dependencies, data, credentials, or `.env`. Do not select a legal license on the owner's behalf.

## Ownership And Layout

`apps/api`: AdonisJS, SQLite migrations, auth/RBAC, REST, integrations, tests.
`apps/web`: Astro, React dashboard, views, settings and separate admin page.
`docs`: architecture, API, deployment, security, research and user guidance.

SQLite targets one application replica on local persistent storage, not an NFS-backed multi-replica cluster. Schema changes require numbered migrations. Build outputs must use the lockfile and run as non-root in Docker.

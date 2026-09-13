# Production remediation implementation plan

**Goal:** Repair the production audit findings in risk order, retaining Vercel as requested.

**Architecture:** Preserve the native HTTP application and local SQLite development mode. Vercel uses the existing Upstash Redis credentials for persistent project documents and operations with atomic Lua transactions. Text revision and document concurrency version are separate. Background operations register their promise with Vercel waitUntil and have a finite deadline.

**Tech stack:** Node 24, SQLite, Upstash REST/Lua, vanilla browser JavaScript, @vercel/functions.

1. P1 editor loss: patch anonymous working copies, keep unsaved state, protect responses against newer input; fix login project transfer. Files public/app.js, test/audit-release.test.mjs.
2. P1 data consistency: remove constructor recovery side effects, read-only diagnostics, atomic result commit with document version, no resurrection. Files src/store.mjs, src/service.mjs, src/db-doctor.mjs, consistency/service tests.
3. P1 identity/cost: atomic OAuth consume/revoke/commit and shared global/IP request budgets. Files src/oauth.mjs, src/kv.mjs, src/budget.mjs, security/integration tests.
4. P1 deployment: implement RedisStore and await storage throughout HTTP handlers; use waitUntil and bounded task lifetime; reject unsafe Vercel local storage fallback. Files src/redis-store.mjs, src/server.mjs, api/index.mjs, vercel.json, runtime tests.
5. P2 correctness: preserve text revision on defer, canonical domain redirect, update deployment docs and add CI. Run full tests, syntax checks, dependency audit and local browser verification. Independently validate Redis Lua with a real isolated Redis when available.

The existing audit tests must assert desired invariants after each fix, rather than treating reproduced defects as passing guarantees. No live user data migration or deployment occurs as part of local verification.

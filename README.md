# kg-tutor

An adaptive tutoring system built on one shared concept graph that every learner
enriches and every learner reuses.

The graph is the universe of knowledge — user-agnostic, slow-moving, continuously
expanded as new topics are requested. A per-learner model decides how each person
crosses it. Teaching produces evidence; evidence is pooled and gated before it can
change anything shared.

Three things compound with usage: the graph, the assessment item bank, and the
explanation library. That is the reason this exists rather than a prompt — a chatbot
tutor has nowhere to put what it learns, so its quality and its cost are flat forever.

## Status

v0 complete: engine, HTTP API and web UI. See `context/progress.md`.

## Running it

First time:

```bash
pnpm setup
```

That installs, starts Postgres, migrates both the dev and test databases, and seeds a
small JavaScript graph so the UI has something in it.

Then, day to day:

```bash
pnpm dev
```

API on **:4000**, UI on **:5173** with hot reload, `/api` proxied. Use `pnpm start`
instead to build the UI and serve everything from :4000 on its own — closer to how it
would actually run.

**It has to be `pnpm`, not `npm`.** The workspace uses `workspace:*` dependencies and a
`pnpm-workspace.yaml`, neither of which npm understands — `npm install` fails outright
rather than degrading. If you do not have it: `corepack enable && corepack prepare pnpm@9 --activate`.

| Command | |
| --- | --- |
| `pnpm setup` | install, database up, migrate, seed |
| `pnpm dev` | both apps, hot reload (:4000 API, :5173 UI) |
| `pnpm start` | build the UI, serve everything from :4000 |
| `pnpm test` | integration tests against `kg_tutor_test` |
| `pnpm typecheck` | every package |
| `pnpm db:reset` | drop the volume and rebuild from scratch |
| `pnpm db:studio` | Prisma Studio |
| `pnpm eval:adjudicator` | score the resolver against the labelled pairs (needs a model) |

Requires Docker, and Node 20+.

**Backing it with Claude Code** (no API key needed, if the CLI is installed):

```bash
LLM_PROVIDER=claude-code pnpm dev
```

Or change it at runtime on the **Settings** tab, which takes effect without a restart.
Roughly 3–6 seconds per call, and each call pays for the CLI's own system prompt, so
cost figures are real spend but are **not** comparable to an API-backed run. Fine for
exercising the system; switch to a key before concluding anything about cost or latency.

Expansion, grading and chat return **503 without any model configured** — deliberately,
since a fabricated concept is worse than a clear failure.

## Design

22 decisions and 8 operating policies, each with the trade-off accepted:
https://claude.ai/code/artifact/25f68658-fc11-43ea-a81d-55222bf4d6f5

Condensed in `context/decisions.md`. Every table in the Prisma schema cites the
decision it comes from.

## Layout

```
context/          plan, decisions, tech stack, progress, related work
packages/db       Prisma schema, migrations, SQL invariant guards
packages/shared   mastery ladder, failure-mode validator, milestone trimming
packages/llm      tiered provider, JSON extraction, scripted provider
packages/graph    resolver, candidate generation, adjudication, expansion, eval
packages/planner  goal resolution, ordering, versioned plans
packages/teach    grading, execution, attempt loop, chat routing, probes, content
packages/metrics  reuse, wasted teaching, persistence, cost per outcome
packages/evidence control-arm claims, promotion proposals, negative evidence
apps/api          Fastify HTTP layer; serves the built web app
apps/web          React + React Flow + elkjs
```

## Getting started

```bash
pnpm install
pnpm db:generate
pnpm db:migrate
```

Requires PostgreSQL 15+ with the `vector` extension available.

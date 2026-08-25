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

```bash
docker compose up -d                      # Postgres 16 + pgvector on :5433
pnpm install
pnpm --filter @kg/db exec prisma migrate deploy
pnpm --filter @kg/api seed                # a small real JS graph to look at
pnpm --filter @kg/web build
pnpm --filter @kg/api start               # http://localhost:4000
```

For UI work, `pnpm --filter @kg/web dev` runs Vite on **:5173** proxying `/api` to :4000.

Five views: **Learn** (the lesson: explanation, check, and chat that routes rather than
teaches), **Graph** (two modes — *explore* clusters by connection to find hubs and gaps,
*teach* layers by dependency to read the order; click any node or edge, focus a
neighbourhood, hop through the breadcrumb), **Learner** (path, milestones, probes due, known concepts,
misconceptions), **Review** (proposals, negative evidence, traversal-ordered queue),
**Metrics** (reuse rate, wasted teaching, cost per verified outcome, arms).

**Backing it with Claude Code** (no API key needed, if the CLI is installed):

```bash
LLM_PROVIDER=claude-code pnpm --filter @kg/api start
```

Roughly 3–6 seconds per call, and each call pays for the CLI's own system prompt, so
cost figures are real spend but are **not** comparable to an API-backed run. Fine for
exercising the system; switch to a key before concluding anything about cost or latency.

Expansion, grading and chat return **503 without any model configured** — deliberately, since a
fabricated concept is worse than a clear failure. Set `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` and restart.

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

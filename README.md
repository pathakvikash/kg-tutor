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

Phase 0. Data model landed, nothing running yet. See `context/progress.md`.

## Design

22 decisions and 8 operating policies, each with the trade-off accepted:
https://claude.ai/code/artifact/25f68658-fc11-43ea-a81d-55222bf4d6f5

Condensed in `context/decisions.md`. Every table in the Prisma schema cites the
decision it comes from.

## Layout

```
context/          plan, decisions, tech stack, progress, related work
packages/db/      Prisma schema + SQL invariant guards
```

## Getting started

```bash
pnpm install
pnpm db:generate
pnpm db:migrate
```

Requires PostgreSQL 15+ with the `vector` extension available.

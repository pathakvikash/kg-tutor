# kg-tutor

An adaptive tutoring system built on one shared concept graph. Every learner adds to
it and every learner reuses it.

The graph is user-agnostic and slow-moving, and it grows whenever someone asks for a
new topic. A per-learner model decides how each person walks through it. Teaching
produces evidence, and evidence is pooled and gated before it can change anything
shared.

The graph, the assessment item bank and the explanation library all improve with
use. A chatbot tutor has nowhere to keep what it learns, so its quality and cost stay
flat.

<!-- screenshot: docs/screenshot.png -->

## Status

v0: the engine, HTTP API and web UI exist and run end to end. It has only been
exercised against scripted and deterministic providers, never a live hosted model.

**Works and is tested** (about 280 integration tests against a real Postgres):

- Database guards enforced by CHECK constraints and triggers: a hard edge needs a
  failure mode, hard prerequisites cannot form a cycle, a concept's sense is immutable.
- Candidate search that combines vector similarity, trigram matching and graph
  neighbours.
- Five-way LLM adjudication of whether a proposed concept is new or already exists,
  with K-sample majority voting.
- Mastery ladder, planner, teaching loop and evidence packages.
- Fastify API and React UI.
- An explicit 503 from expansion, grading and chat when no model is configured,
  instead of invented content.

**Not yet proven:**

- The Anthropic and OpenAI-compatible providers have never made a live call.
- The default model IDs (`packages/llm/src/providers.ts`) are unverified.
- Without an embedding key, embeddings fall back to a deterministic lexical hash, so
  the semantic arm of dedup cannot match synonyms that share no wording.
- The adjudicator eval (about 12 labelled pairs, `pnpm eval:adjudicator`) has never
  been run against a real model, so there are no accuracy numbers.
- The seed graph has 16 concepts.
- Expansion jobs run in-process and are lost on restart (they are marked failed on
  the next start).
- There is no Dockerfile, and no user auth. The only protection is a per-IP rate limit
  and an admin token on the model settings and code execution routes.
- The deploy path in the Deploy section has not been run end to end.

Running notes are in `context/progress.md`.

## Architecture

pnpm workspace with Turborepo. Postgres 16 with `pgvector` and `pg_trgm` holds the
graph, learner state and evidence.

| Package | Role |
| --- | --- |
| `packages/db` | Prisma schema, migrations, SQL invariant guards |
| `packages/shared` | Mastery ladder, failure-mode validator, milestone trimming |
| `packages/llm` | Tiered (small/strong) model providers, JSON extraction, scripted test provider |
| `packages/graph` | Concept resolver: candidate search, adjudication, expansion, eval |
| `packages/planner` | Goal resolution, ordering, versioned plans |
| `packages/teach` | Grading, lesson execution, attempt loop, chat routing, probes |
| `packages/metrics` | Reuse, wasted teaching, persistence, cost per outcome |
| `packages/evidence` | Control-arm claims, promotion proposals, negative evidence |
| `apps/api` | Fastify HTTP layer; also serves the built web app |
| `apps/web` | React, React Flow and elkjs UI |

## Running it

Requires Node 20+, pnpm 9 and Docker. The database is `pgvector/pgvector:pg16`
(Postgres 16 with `vector`; the `pg_trgm` extension is created by a migration).

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

API on :4000, UI on :5173 with hot reload and `/api` proxied. `pnpm start` builds the
UI and serves everything from :4000, which is closer to how it would run for real.

Use `pnpm`, not `npm`. The workspace relies on `workspace:*` dependencies and
`pnpm-workspace.yaml`, so `npm install` fails outright. To get pnpm:
`corepack enable && corepack prepare pnpm@9 --activate`.

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

With an API key (not yet verified live, see Status): set `ANTHROPIC_API_KEY`, or
`OPENAI_API_KEY` / `LLM_API_KEY` for an OpenAI-compatible endpoint. Embeddings use
`EMBEDDING_API_KEY` or `OPENAI_API_KEY`. Override model IDs with `LLM_MODEL_SMALL` and
`LLM_MODEL_STRONG`.

With Claude Code (no API key needed, if the CLI is installed):

```bash
LLM_PROVIDER=claude-code pnpm dev
```

You can also switch on the Settings tab, which takes effect without a restart. Calls
take about 3 to 6 seconds, and each one pays for the CLI's own system prompt. The cost
figures are real spend but not comparable to an API-backed run, so use this to
exercise the system and switch to a key before judging cost or latency. The CLI
provider is disabled when `NODE_ENV=production`.

Expansion, grading and chat return 503 when no model is configured. A fabricated
concept is worse than a clear failure.

## Deploy

A public demo runs as web on Vercel, API on Render and Postgres on Neon. None of this
has been run end to end yet.

1. Neon: create a project (Postgres 16). Copy the direct connection string, not the
   pooled one, because `prisma migrate deploy` takes advisory locks. `vector` and
   `pg_trgm` are created by the migrations, and Neon supports both.
2. Render: New, Blueprint, pick this repo (it reads `render.yaml`). Set the env vars
   below. On start it runs `pnpm db:deploy` (migrations) and then the API. Check
   `/api/health` on the service URL.
3. Seed once from your machine against the deployed database:
   `DATABASE_URL='<neon url>' pnpm db:seed`. It is safe to run again.
4. Vercel: import the repo, set the root directory to `apps/web`, and add
   `VITE_API_URL=<render url>` with no trailing slash. `apps/web/vercel.json` handles
   the SPA rewrite.
5. Back on Render, set `CORS_ORIGIN` to the Vercel URL and redeploy.

API environment (Render):

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Neon direct connection string |
| `CORS_ORIGIN` | Comma-separated allowed origins, for example the Vercel URL |
| `ADMIN_TOKEN` | Bearer token for `PUT /api/settings/model` and `/api/execute`. Unset in production means both return 403 |
| `ANTHROPIC_API_KEY` | Without a key, model routes return 503 |
| `EMBEDDING_API_KEY` | Without it, embeddings fall back to the lexical hash |
| `TRUST_PROXY` | Number of proxy hops in front of the API, so rate limits see the real client IP |
| `RATE_LIMIT_MAX` | Requests per minute per IP, default 60 |
| `RATE_LIMIT_LLM_MAX` | Per minute per IP on routes that call a model, default 10 |
| `HOST`, `PORT` | Default `0.0.0.0` and `4000` |
| `NODE_ENV` | `production` on Render. Disables the Claude Code provider |

Web environment (Vercel): `VITE_API_URL`.

There is no daily spend cap, because only the Claude Code provider records cost.
Set a monthly limit on the key in the Anthropic console.

## Design

The 22 decisions and 8 operating policies, with the trade-off accepted for each, are
in `context/decisions.md`. That folder is gitignored, so it only exists in the
author's checkout.

## Roadmap

- A live model run, with eval numbers for the adjudicator and verified default model IDs.
- CI and a Dockerfile.
- A job queue so expansion survives restarts.
- Real auth, and usage tracking for the API providers so a spend cap is possible.

## License

MIT, see `LICENSE`.

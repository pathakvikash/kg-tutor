import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { extractJson, type LLMProvider } from "@kg/llm";
import { assignVariant } from "@kg/teach";
import { prisma } from "../context.js";

/** Must stay in step with apps/web/src/widget/catalog.ts; a name missing there renders nothing */
const CATALOG = `Components you may use. Anything not listed here does not exist.

Stack        { gap?: number }                      Vertical layout. Use as the root.
Heading      { value: string }                     Short section label.
Text         { value: string, muted?: boolean }    A paragraph. Plain text only.
CodeBlock    { code, language?, highlightLine? }   Source code. Never prose.
Timeline     { steps: Step[], stateKey?: string }  Learner-advanced execution steps.
Frames       { title?, items: string[], orientation?: "stack"|"queue", empty? }
Simulation   { code, language?, regions: string[], stackRegions?: string[],
               steps: MachineStep[], stateKey? }
Compare      { leftTitle, leftCode, rightTitle, rightCode, note? }
Choice       { question, options: {label, correct, feedback}[] }
Toggle       { label, stateKey?, onText?, offText? }

Step        = { label, detail?, code?, highlightLine? }
MachineStep = { label, detail?, highlightLine?, regions: { [regionName]: string[] } }

Simulation is THE component for architecture and life cycle. Several named regions — a
call stack, a task queue, a microtask queue, console output — all changing together as
the learner steps through one program. Every step must list the contents of EVERY
region at that instant, even the empty ones, so movement between them is visible rather
than inferred. Put stack-like regions in stackRegions so they grow upward.

Reach for it whenever the question is about how something works, what moves where, or
the full life cycle of something. A Timeline plus a paragraph is the wrong answer to
"what is the architecture of X".`;

const WIDGET_SYSTEM = `You build a small interactive widget that teaches one concept.

${CATALOG}

Spec format:
{
  "root": "main",
  "state": { "step": 0 },
  "elements": {
    "main": { "type": "Stack", "props": { "gap": 14 }, "children": ["a", "b"] },
    "a":    { "type": "Heading", "props": { "value": "..." }, "children": [] },
    ...
  }
}

Binding: a prop may read state with { "$state": "/step" } instead of a literal. Use this
to make Frames change as a Timeline advances — put the per-step arrays in state and index
them, or give each step its own element.

Rules:
- The widget must show something prose cannot. If a paragraph would do the same job,
  build a Timeline or a Simulation instead — sequence, movement and state changes are
  what this is for.
- Architecture, life cycle, "what are the parts and how do they interact": Simulation.
- A single ordered walkthrough with no moving parts: Timeline.
- Prefer ONE stepped component the learner drives over many static blocks.
- Every element id referenced in "children" must exist in "elements".
- Do not invent components or props. Do not use markdown anywhere.
- 3 to 7 elements. Small and sharp beats comprehensive.

Respond with the JSON spec and nothing else.`;

/** A model-authored spec is untrusted: a dangling child id renders as a blank page */
function validateSpec(raw: unknown): { ok: true; spec: any } | { ok: false; reason: string } {
  const parsed = z
    .object({
      root: z.string(),
      state: z.record(z.string(), z.unknown()).optional(),
      elements: z.record(
        z.string(),
        z.object({
          type: z.string(),
          props: z.record(z.string(), z.unknown()).optional(),
          children: z.array(z.string()).optional(),
        }),
      ),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? "bad shape" };

  const spec = parsed.data;
  if (!spec.elements[spec.root]) return { ok: false, reason: `root "${spec.root}" is not an element` };

  const known = new Set([
    "Stack", "Heading", "Text", "CodeBlock", "Timeline", "Frames",
    "Simulation", "Compare", "Choice", "Toggle",
  ]);
  for (const [id, el] of Object.entries(spec.elements)) {
    if (!known.has(el.type)) return { ok: false, reason: `unknown component "${el.type}" on "${id}"` };
    for (const child of el.children ?? []) {
      if (!spec.elements[child]) return { ok: false, reason: `"${id}" references missing child "${child}"` };
    }
  }
  return { ok: true, spec };
}

async function generate(llm: LLMProvider, user: string): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.complete({
      system: WIDGET_SYSTEM,
      user: attempt === 0 ? user : `${user}\n\nYour previous spec was rejected. Fix it and return only JSON.`,
      tier: "strong",
      temperature: 0.4,
    });
    const check = validateSpec(extractJson(raw));
    if (check.ok) return check.spec;
    if (attempt === 1) throw new Error(`widget spec invalid: ${check.reason}`);
  }
}

export async function widgetRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/lesson/widget", async (req, reply) => {
    const body = z
      .object({
        conceptId: z.string(),
        focus: z.string().optional(),
        learnerId: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const llm = req.llm;
    if (!llm) return reply.code(503).send({ error: "no model configured", detail: "Add your API key in Settings." });

    const concept = await prisma.concept.findUniqueOrThrow({ where: { id: body.data.conceptId } });
    const prereqs = await prisma.edge.findMany({
      where: { dstId: concept.id, type: "prerequisite_of", strength: "hard", retiredAt: null },
      include: { src: true },
    });

    try {
      const spec = await generate(
        llm,
        [
          `Concept: ${concept.canonicalName}`,
          `Meaning: ${concept.sense}`,
          body.data.focus ? `The learner asked specifically about: ${body.data.focus}` : "",
          prereqs.length > 0
            ? `Misunderstandings worth pre-empting:\n${prereqs
                .filter((p) => p.failureMode)
                .map((p) => `- ${p.failureMode}`)
                .join("\n")}`
            : "",
        ].filter(Boolean).join("\n"),
      );
      if (body.data.learnerId) {
        const learnerId = body.data.learnerId;
        const open = await prisma.session.findFirst({
          where: { learnerId, endedAt: null }, orderBy: { startedAt: "desc" },
        });
        const sessionId =
          open?.id ??
          (await prisma.session.create({
            data: { learnerId, variant: assignVariant(learnerId) },
          })).id;
        await prisma.lessonTurn.create({
          data: {
            sessionId, learnerId, conceptId: concept.id,
            role: "widget", text: concept.canonicalName, meta: { spec } as never,
          },
        });
      }
      return { conceptId: concept.id, conceptName: concept.canonicalName, spec };
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

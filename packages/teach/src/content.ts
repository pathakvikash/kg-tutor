import { z } from "zod";
import { Prisma } from "@kg/db";
import type { PrismaClient } from "@kg/db";
import { arrayOrWrapped, completeJson, type LLMProvider } from "@kg/llm";
import type { MasteryLevel } from "@kg/shared";

const itemSchema = arrayOrWrapped(
  "items",
  z.object({
    prompt: z.string().min(1),
    /** Kept out of `prompt` so newlines survive rendering. */
    code: z.string().nullable().default(null),
    codeLanguage: z.string().nullable().default(null),
    targetsLevel: z.enum(["familiar", "functional", "solid"]),
    requiresTransfer: z.boolean(),
    /** What a correct answer must demonstrate — not a model answer to match against. */
    mustDemonstrate: z.array(z.string()).min(1),
  }),
);

const ITEM_SYSTEM = `You write assessment items for a single learning concept.

Each item must DISCRIMINATE: a learner who understands the concept answers it correctly,
and one who does not, cannot. An item answerable by repeating a definition is worthless.

Levels:
- "familiar": can state what it is in their own words
- "functional": can apply it in a situation they have seen the shape of before
- "solid": can apply it in an unfamiliar context, or debug it when it goes wrong

Set requiresTransfer true when the item deliberately uses a context the learner's
explanation would not have covered. At least one item per concept must do this — without
transfer items, a fluent paraphrase promotes a learner who cannot use the concept.

Every item must be ABOUT THE CONCEPT NAMED ABOVE. You may be given the failure modes of
its prerequisites; those are the bar the item has to clear, not its subject. An item on
"binary search tree" that turns out to be a question about reference aliasing is testing
the prerequisite, and a learner who knows binary search trees but slips on aliasing is
then recorded as not knowing binary search trees. Use the prerequisite failure modes to
make the item unanswerable by someone who lacks them — never as the thing being asked.

Write exactly FOUR items: one "familiar", two "functional", one "solid". Language
variants mean a concept can now hold a bank per language, so an unbounded count multiplies
— and this is already the most expensive call the system makes.

mustDemonstrate lists what a correct answer has to show. Write it as observable claims,
not as a model answer. Two or three short claims, not a rubric.

If a language is given, write EVERY item in it, and set codeLanguage to it. That
instruction outranks the topic and outranks whatever language the concept is usually
taught in: "memory addresses" is usually taught in C, and a learner working in JavaScript
handed a "realloc" bug has to learn C before they can answer, at which point the item is
measuring their C. Express the idea in the given language even where that language hides
the mechanism — reason about what references actually hold, rather than reaching for
pointer syntax it does not have.

If no language is given, prefer pseudocode or prose over picking one at random.

If the question is about a snippet, put the snippet in the "code" field with its
language in "codeLanguage" — NOT inside "prompt". Code embedded in prose loses its line
breaks when rendered and arrives as one unreadable line. "prompt" is then just the
question about it: "Predict the output order." Any short identifier that must appear
mid-sentence goes in backticks.

Respond with JSON: {"items":[{"prompt","code","codeLanguage","targetsLevel","requiresTransfer","mustDemonstrate"}]}`;

/**
 * Items are stored, versioned objects on the Concept — not regenerated per learner. (07)
 *
 * Fresh questions every session would make cross-learner statistics impossible, and
 * those statistics are the only way an item bank improves. Generated items enter as
 * candidates and earn `canonical` through use, like everything else.
 */
export async function generateItems(
  prisma: PrismaClient,
  llm: LLMProvider,
  conceptId: string,
  opts: { language?: string | null | undefined } = {},
): Promise<{ created: number }> {
  const concept = await prisma.concept.findUniqueOrThrow({ where: { id: conceptId } });
  const prereqs = await prisma.edge.findMany({
    where: { dstId: conceptId, type: "prerequisite_of", strength: "hard", retiredAt: null },
    include: { src: true },
  });
  // Items are shared across learners, so this cannot come from the learner's goal. It
  // comes from the topics the concept belongs to, which are shared too — "functions"
  // under "Asynchronous JavaScript" is a JavaScript item for everyone who reaches it.
  const topics = await prisma.topicConcept.findMany({
    where: { conceptId },
    include: { topic: true },
  });

  const out = await completeJson(
    llm,
    {
      system: ITEM_SYSTEM,
      user: [
        `Concept: ${concept.canonicalName}`,
        `Meaning: ${concept.sense}`,
        topics.length > 0
          ? `Studied as part of: ${topics.map((t) => t.topic.name).join(", ")}`
          : "",
        // The strongest signal available, and the only one that was missing.
        opts.language ? `Write every item in: ${opts.language}` : "",
        // Named as the bar, not the subject. Headed "failure modes to probe for", this
        // list became the topic: a binary-search-tree item came back asking about
        // shallow-copy aliasing, because that is its prerequisite's failure mode.
        prereqs.length > 0
          ? `A learner who has NOT mastered the prerequisites fails in these specific ways.\n` +
            `Write items that such a learner cannot answer — but keep every question about\n` +
            `${concept.canonicalName} itself:\n${prereqs
              .filter((p) => p.failureMode)
              .map((p) => `- (missing ${p.src.canonicalName}) ${p.failureMode}`)
              .join("\n")}`
          : "",
      ].filter(Boolean).join("\n"),
      tier: "strong",
      temperature: 0.4,
    },
    itemSchema,
  );

  const existing = await prisma.assessmentItem.findMany({ where: { conceptId } });
  const seen = new Set(existing.map((e) => e.prompt.trim().toLowerCase()));

  let created = 0;
  for (const item of (out.items ?? []).slice(0, 6)) {
    if (seen.has(item.prompt.trim().toLowerCase())) continue;
    await prisma.assessmentItem.create({
      data: {
        conceptId,
        prompt: item.prompt,
        code: item.code ?? null,
        // The requested language wins over whatever the model labelled it, so selection
        // can rely on the tag actually meaning something.
        codeLanguage: item.code ? (opts.language ?? item.codeLanguage ?? null) : null,
        rubric: { mustDemonstrate: item.mustDemonstrate } as Prisma.InputJsonValue,
        targetsLevel: item.targetsLevel as MasteryLevel,
        requiresTransfer: item.requiresTransfer,
        status: "candidate",
      },
    });
    created++;
  }
  return { created };
}

/**
 * Picks an item for the level being tested. Prefers canonical over candidate, then the
 * item that best separates learners who understand from those who do not. (07)
 */
/** Languages close enough that an item written in one reads fine to the other. */
const SAME_FAMILY: Record<string, string[]> = {
  javascript: ["javascript", "js", "typescript", "ts", "jsx", "tsx", "node"],
  typescript: ["typescript", "ts", "javascript", "js", "tsx", "jsx"],
  python: ["python", "py"],
  rust: ["rust", "rs"],
  go: ["go", "golang"],
  java: ["java"],
  c: ["c"],
  "c++": ["c++", "cpp"],
  sql: ["sql", "postgres", "postgresql"],
};

/**
 * Picks an item for the level being tested. Prefers canonical over candidate, then the
 * item that best separates learners who understand from those who do not. (07)
 *
 * `language` sorts before all of that, because a mismatch does not make the item weaker,
 * it makes it measure something else: a JavaScript learner asked to diagnose a `realloc`
 * bug is being tested on C. An item with no code at all is language-neutral and always
 * acceptable. A wrong-language item is returned only when there is nothing else — better
 * a hard question than no question — and the caller can generate a variant instead.
 */
export async function selectItem(
  prisma: PrismaClient,
  conceptId: string,
  targetsLevel: MasteryLevel,
  excludeItemIds: string[] = [],
  opts: { language?: string | null | undefined } = {},
) {
  const items = await prisma.assessmentItem.findMany({
    where: {
      conceptId,
      targetsLevel,
      status: { not: "retired" },
      ...(excludeItemIds.length > 0 ? { id: { notIn: excludeItemIds } } : {}),
    },
  });
  if (items.length === 0) return null;

  const want = opts.language?.toLowerCase().trim();
  const family = want ? (SAME_FAMILY[want] ?? [want]) : null;
  const rank = (lang: string | null): number => {
    if (!family) return 1;                                  // no preference stated
    if (!lang) return 1;                                    // prose or pseudocode: fine
    return family.includes(lang.toLowerCase().trim()) ? 2 : 0;
  };

  return items.sort(
    (a, b) =>
      rank(b.codeLanguage) - rank(a.codeLanguage) ||
      Number(b.status === "canonical") - Number(a.status === "canonical") ||
      b.discrimination - a.discrimination ||
      a.timesUsed - b.timesUsed,
  )[0]!;
}

/** True when the best available item is in a language the learner does not write. */
export function isWrongLanguage(
  item: { codeLanguage: string | null },
  language: string | null | undefined,
): boolean {
  if (!language || !item.codeLanguage) return false;
  const family = SAME_FAMILY[language.toLowerCase().trim()] ?? [language.toLowerCase().trim()];
  return !family.includes(item.codeLanguage.toLowerCase().trim());
}

export interface ItemStatsUpdate {
  itemId: string;
  timesUsed: number;
  successRate: number;
  discrimination: number;
  action: "kept" | "retired" | "promoted";
}

/**
 * Item statistics are the one tier that promotes automatically: local, purely
 * statistical, and self-correcting if wrong. (11)
 *
 * Discrimination is measured against whether getting the item right predicts later
 * success on concepts that depend on this one. An item everyone passes tells you
 * nothing; an item that passing predicts nothing about tells you less.
 */
export async function updateItemStats(
  prisma: PrismaClient,
  conceptId: string,
  minUses = 30,
): Promise<ItemStatsUpdate[]> {
  const items = await prisma.assessmentItem.findMany({ where: { conceptId } });
  const dependents = await prisma.edge.findMany({
    where: { srcId: conceptId, type: "prerequisite_of", retiredAt: null },
    select: { dstId: true },
  });
  const dependentIds = dependents.map((d) => d.dstId);

  const out: ItemStatsUpdate[] = [];
  for (const item of items) {
    if (item.timesUsed < minUses) continue;
    const successRate = item.timesUsed === 0 ? 0 : item.correctCount / item.timesUsed;

    let discrimination = 0;
    if (dependentIds.length > 0) {
      const attempts = await prisma.evidenceEvent.findMany({
        where: { itemId: item.id },
        select: { learnerId: true, kind: true },
      });
      const passed = attempts.filter((a) => a.kind === "applied" || a.kind === "transferred");
      const failed = attempts.filter((a) => a.kind === "failed_check");
      const downstreamRate = async (learnerIds: string[]) => {
        if (learnerIds.length === 0) return 0;
        const wins = await prisma.evidenceEvent.count({
          where: {
            learnerId: { in: learnerIds },
            conceptId: { in: dependentIds },
            kind: { in: ["applied", "transferred"] },
          },
        });
        return wins / learnerIds.length;
      };
      discrimination =
        (await downstreamRate(passed.map((p) => p.learnerId))) -
        (await downstreamRate(failed.map((f) => f.learnerId)));
    }

    // Everyone passes or everyone fails: it separates nobody.
    const uninformative = successRate > 0.97 || successRate < 0.03;
    const antiPredictive = dependentIds.length > 0 && discrimination < -0.1;
    const action: ItemStatsUpdate["action"] =
      uninformative || antiPredictive
        ? "retired"
        : discrimination > 0.2 && item.status === "candidate"
          ? "promoted"
          : "kept";

    await prisma.assessmentItem.update({
      where: { id: item.id },
      data: {
        discrimination,
        ...(action === "retired" ? { status: "retired" as const } : {}),
        ...(action === "promoted" ? { status: "canonical" as const } : {}),
      },
    });
    out.push({ itemId: item.id, timesUsed: item.timesUsed, successRate, discrimination, action });
  }
  return out;
}

/**
 * Explanation candidates earn `canonical` the same way, but on a different signal:
 * whether the learners who saw them went on to pass. (12)
 */
export async function promoteExplanations(
  prisma: PrismaClient,
  conceptId: string,
  minShown = 30,
): Promise<{ contentId: string; passRate: number; action: "promoted" | "retired" | "kept" }[]> {
  const contents = await prisma.explanationContent.findMany({
    where: { conceptId, status: "candidate" },
  });
  const out: { contentId: string; passRate: number; action: "promoted" | "retired" | "kept" }[] = [];
  for (const c of contents) {
    if (c.timesShown < minShown) continue;
    const passRate = c.timesShown === 0 ? 0 : c.followedByPass / c.timesShown;
    const action = passRate >= 0.7 ? "promoted" : passRate < 0.3 ? "retired" : "kept";
    if (action !== "kept") {
      await prisma.explanationContent.update({
        where: { id: c.id },
        data: { status: action === "promoted" ? "canonical" : "retired" },
      });
    }
    out.push({ contentId: c.id, passRate, action });
  }
  return out;
}

/** Splits already-written compound concept names; repair:compound-concepts [--apply] */
import { PrismaClient } from "@kg/db";
import { checkConceptName } from "@kg/shared";
import { splitCompoundConcept, DeterministicEmbedding, LLMAdjudicator } from "@kg/graph";
import { completeJson, llmFromEnv } from "@kg/llm";
import { z } from "zod";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const all = await prisma.concept.findMany({
    where: { deprecatedAt: null },
    select: { id: true, canonicalName: true },
    orderBy: { canonicalName: "asc" },
  });
  const bad = all
    .map((c) => ({ ...c, check: checkConceptName(c.canonicalName) }))
    .filter((c) => !c.check.ok);

  if (bad.length === 0) {
    console.log("No compound concept names found.");
    await prisma.$disconnect();
    return;
  }

  console.log(`${bad.length} concept name(s) that do not denote one concept:\n`);
  for (const c of bad) {
    const halves = (c.check.parts ?? []).filter((h) => checkConceptName(h).ok);
    const existing: string[] = [];
    for (const h of halves) {
      const hit = await prisma.concept.findFirst({
        where: { canonicalName: { equals: h, mode: "insensitive" }, deprecatedAt: null },
      });
      if (hit) existing.push(hit.canonicalName);
    }
    const edges = await prisma.edge.count({
      where: { OR: [{ srcId: c.id }, { dstId: c.id }], retiredAt: null },
    });
    const states = await prisma.learnerConceptState.count({ where: { conceptId: c.id } });
    console.log(`  ${c.canonicalName}`);
    console.log(
      `      ${c.check.reason} · ${edges} edge(s) · ${states} mastery row(s) · ` +
        (halves.length > 0
          ? `split into ${halves.join(" + ")}${existing.length > 0 ? ` (already present: ${existing.join(", ")})` : ""}`
          : "no usable halves — deprecated without a successor"),
    );
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to split them.");
    await prisma.$disconnect();
    return;
  }

  const llm = llmFromEnv();
  if (!llm) {
    console.error("\nA model is needed: the resolver adjudicates each half against what exists.");
    process.exit(1);
  }
  const resolver = {
    prisma,
    embedding: new DeterministicEmbedding(),
    adjudicator: new LLMAdjudicator(llm),
  };

  const partsSchema = z.object({
    parts: z.array(z.object({ name: z.string().min(1), sense: z.string().min(1) })).min(1),
  });

  const PARTS_SYSTEM = `A concept name was written that denotes more than one concept. Name the concepts it contains.

Each name is a short noun phrase for ONE concept — at most a few words, no "and", no
"or", no slash joining two things, no trailing "concepts"/"basics"/"terminology".

Distribute a shared head noun rather than leaving a half bare: "width and height
properties" is "width property" and "height property", not "width" and "height
properties". But do not distribute when the halves are independent: "variables and
memory allocation" is "variables" and "memory allocation".

Each "sense" is one sentence saying what that concept is — written for that concept
alone, not inherited from the compound. It becomes immutable, so make it correct.

If the name is a heading rather than a compound ("graph connectivity concepts"), return
the single real concept underneath it ("graph connectivity").

Respond with JSON: {"parts":[{"name","sense"}]}`;

  const partsFor = async (compound: {
    name: string; sense: string; reason: string; suggested: string[];
  }) => {
    const out = await completeJson(
      llm,
      {
        system: PARTS_SYSTEM,
        user: [
          `Compound name: ${compound.name}`,
          `Its recorded sense: ${compound.sense}`,
          `Why it was rejected: ${compound.reason}`,
          compound.suggested.length > 0
            ? `A blunt split gives: ${compound.suggested.join(" | ")} — improve on it if it is wrong.`
            : "A blunt split gives nothing usable.",
        ].join("\n"),
        tier: "small",
        temperature: 0,
      },
      partsSchema,
    );
    return out.parts;
  };

  console.log("");
  for (const c of bad) {
    const result = await splitCompoundConcept(prisma, resolver, c.id, partsFor);
    if (!result) {
      console.log(`  ${c.canonicalName}: nothing to do`);
      continue;
    }
    const into = result.parts
      .map((p) => `${p.name}${p.reused ? " (reused)" : " (new)"}`)
      .join(" + ");
    console.log(
      `  ${result.name} -> ${into || "(no successor)"} · ` +
        `${result.edgesRewritten} edge(s) rewritten · ${result.itemsRetired} item(s) retired · ` +
        `${result.masteryRowsStranded} mastery row(s) left on the deprecated concept`,
    );
  }
  console.log("\nDone. Replan any affected learner to pick up the new structure.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

/** Writes capability claims for topics that have none; backfill:milestones [--apply] */
import { PrismaClient } from "@kg/db";
import { generateMilestones } from "@kg/graph";
import { llmFromEnv } from "@kg/llm";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const topics = await prisma.topic.findMany({
    include: {
      _count: { select: { milestones: true } },
      concepts: { where: { relation: "contains", concept: { deprecatedAt: null } }, select: { id: true } },
    },
    orderBy: { name: "asc" },
  });
  // Under three concepts there is no capability to claim
  const need = topics.filter((t) => t._count.milestones === 0 && t.concepts.length >= 3);

  if (need.length === 0) {
    console.log("Every topic with enough concepts already has milestones.");
    await prisma.$disconnect();
    return;
  }

  console.log(`${need.length} topic(s) with concepts but no milestones:\n`);
  for (const t of need) console.log(`  ${t.name} — ${t.concepts.length} concepts`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write them.");
    await prisma.$disconnect();
    return;
  }

  const llm = llmFromEnv();
  if (!llm) {
    console.error("\nA model is needed to name capabilities.");
    process.exit(1);
  }

  console.log("");
  for (const t of need) {
    const r = await generateMilestones(prisma, llm, t.id);
    console.log(`  ${t.name}: ${r.written.length} written, ${r.rejected.length} rejected`);
    for (const m of r.written) console.log(`      ✓ ${m.claim}  [${m.concepts.join(", ")}]`);
    for (const m of r.rejected) console.log(`      ✗ ${m.claim}  (${m.reason})`);
  }
  console.log("\nDone. Replan any affected learner to attach them.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

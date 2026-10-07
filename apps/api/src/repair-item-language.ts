/** Retires assessment items whose language contradicts their topic; pass --apply to commit */
import { PrismaClient } from "@kg/db";

const prisma = new PrismaClient();

const TOPIC_LANGUAGE: [RegExp, string][] = [
  [/\bjavascript\b|\btypescript\b|\bnode(\.js)?\b|\breact\b/i, "javascript"],
  [/\bpython\b|\bdjango\b|\bpandas\b/i, "python"],
  [/\brust\b/i, "rust"],
  [/\bgo(lang)?\b/i, "go"],
  [/\bsql\b|\bpostgres\b/i, "sql"],
];

/** Keep these narrow: a pattern that also matches another language retires a good item */
const PROSE_MARKERS: [RegExp, string][] = [
  [/\bin C\b|\bmalloc\b|\bcalloc\b|\brealloc\b|\bprintf\b|\bsizeof\b|\bstruct\s+\w+\s*\{|\bint\s+\w+\s*\[/, "c"],
  [/\bdef\s+\w+\s*\(|\bin Python\b|\bself\.|\b__init__\b|\bprint\(/, "python"],
  [/\bpublic\s+static\s+void\b|\bSystem\.out\.|\bin Java\b/, "java"],
  [/\bfn\s+\w+\s*\(|\blet\s+mut\b|\bin Rust\b|\bVec<|\b&str\b/, "rust"],
  [/\bfunc\s+\w+\s*\(|\bin Go\b|\b:=\s/, "go"],
];

function detectLanguage(item: { codeLanguage: string | null; prompt: string; code: string | null }): string | null {
  const tag = item.codeLanguage?.toLowerCase().trim();
  if (tag && tag !== "none") return tag;
  if (tag === "none") return null;
  const text = `${item.prompt}\n${item.code ?? ""}`;
  for (const [pattern, lang] of PROSE_MARKERS) if (pattern.test(text)) return lang;
  return null;
}

const COMPATIBLE: Record<string, string[]> = {
  javascript: ["javascript", "js", "typescript", "ts", "jsx", "tsx", "node"],
  python: ["python", "py"],
  rust: ["rust", "rs"],
  go: ["go", "golang"],
  sql: ["sql", "postgres", "postgresql", "plpgsql"],
};

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const items = await prisma.assessmentItem.findMany({
    where: { status: { not: "retired" } },
    include: { concept: { include: { topics: { include: { topic: true } } } } },
  });

  const doomed: { id: string; name: string; lang: string; topics: string; expected: string }[] = [];

  for (const item of items) {
    const topicNames = item.concept.topics.map((t) => t.topic.name);
    // A mismatch only counts when every topic the concept sits under agrees on a language
    const implied = new Set<string>();
    for (const name of topicNames) {
      for (const [pattern, lang] of TOPIC_LANGUAGE) if (pattern.test(name)) implied.add(lang);
    }
    if (implied.size !== 1) continue;

    const expected = [...implied][0]!;
    const actual = detectLanguage(item) ?? "";
    if (actual === "") continue;
    if (COMPATIBLE[expected]?.includes(actual)) continue;
    if (actual === "text" || actual === "pseudocode") continue;

    doomed.push({
      id: item.id,
      name: item.concept.canonicalName,
      lang: actual,
      topics: topicNames.join(", "),
      expected,
    });
  }

  if (doomed.length === 0) {
    console.log("No language-mismatched items found.");
  } else {
    console.log(`${doomed.length} item(s) written in the wrong language:\n`);
    for (const d of doomed) {
      console.log(`  ${d.name}  [${d.lang}, expected ${d.expected}]  — topics: ${d.topics}`);
    }
    if (apply) {
      const { count } = await prisma.assessmentItem.updateMany({
        where: { id: { in: doomed.map((d) => d.id) } },
        data: { status: "retired" },
      });
      console.log(`\nRetired ${count}. The generator will refill these levels on the next pass.`);
    } else {
      console.log("\nDry run. Re-run with --apply to retire them.");
    }
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

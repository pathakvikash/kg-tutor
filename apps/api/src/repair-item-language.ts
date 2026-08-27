/**
 * Retires stored assessment items written in a language their topic contradicts.
 *
 * Items are shared, versioned rows on the Concept, so fixing the generator does nothing
 * about the ones already in the bank. A learner working through "JavaScript Fundamentals"
 * was being handed a Python traceback and asked to explain it — at that point the item
 * measures their Python, not the concept it claims to assess.
 *
 * Retiring rather than deleting: `selectItem` already skips retired items, the statistics
 * they accumulated stay auditable, and the generator refills the level on the next pass.
 *
 * Run with: pnpm --filter @kg/api repair:item-language [--apply]
 * Without --apply it prints what it would retire and changes nothing.
 */
import { PrismaClient } from "@kg/db";

const prisma = new PrismaClient();

/** Topic name fragments that pin a topic to one language. */
const TOPIC_LANGUAGE: [RegExp, string][] = [
  [/\bjavascript\b|\btypescript\b|\bnode(\.js)?\b|\breact\b/i, "javascript"],
  [/\bpython\b|\bdjango\b|\bpandas\b/i, "python"],
  [/\brust\b/i, "rust"],
  [/\bgo(lang)?\b/i, "go"],
  [/\bsql\b|\bpostgres\b/i, "sql"],
];

/**
 * Language given away by the prompt or code text rather than by the tag.
 *
 * Deliberately narrow: each pattern is something that cannot plausibly appear in the
 * other languages here, so a false positive retires a good item. "array" or "function"
 * would match everything; `malloc` and `printf` do not.
 */
const PROSE_MARKERS: [RegExp, string][] = [
  [/\bin C\b|\bmalloc\b|\bcalloc\b|\brealloc\b|\bprintf\b|\bsizeof\b|\bstruct\s+\w+\s*\{|\bint\s+\w+\s*\[/, "c"],
  [/\bdef\s+\w+\s*\(|\bin Python\b|\bself\.|\b__init__\b|\bprint\(/, "python"],
  [/\bpublic\s+static\s+void\b|\bSystem\.out\.|\bin Java\b/, "java"],
  [/\bfn\s+\w+\s*\(|\blet\s+mut\b|\bin Rust\b|\bVec<|\b&str\b/, "rust"],
  [/\bfunc\s+\w+\s*\(|\bin Go\b|\b:=\s/, "go"],
];

/** The language an item is written in, from its tag or, failing that, its text. */
function detectLanguage(item: { codeLanguage: string | null; prompt: string; code: string | null }): string | null {
  const tag = item.codeLanguage?.toLowerCase().trim();
  if (tag && tag !== "none") return tag;
  if (tag === "none") return null;
  const text = `${item.prompt}\n${item.code ?? ""}`;
  for (const [pattern, lang] of PROSE_MARKERS) if (pattern.test(text)) return lang;
  return null;
}

/** Languages that are close enough not to count as a mismatch. */
const COMPATIBLE: Record<string, string[]> = {
  javascript: ["javascript", "js", "typescript", "ts", "jsx", "tsx", "node"],
  python: ["python", "py"],
  rust: ["rust", "rs"],
  go: ["go", "golang"],
  sql: ["sql", "postgres", "postgresql", "plpgsql"],
};

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  /**
   * Every live item, not only the tagged ones.
   *
   * The first version of this only looked at items with a codeLanguage, which missed the
   * whole class that caused the complaint: a question reading "a student declares
   * `int scores[100];` in C" carries its language inline in the prompt, so the code field
   * is empty and codeLanguage is null. Untagged did not mean neutral, it meant unexamined.
   */
  const items = await prisma.assessmentItem.findMany({
    where: { status: { not: "retired" } },
    include: { concept: { include: { topics: { include: { topic: true } } } } },
  });

  const doomed: { id: string; name: string; lang: string; topics: string; expected: string }[] = [];

  for (const item of items) {
    const topicNames = item.concept.topics.map((t) => t.topic.name);
    // Every topic the concept sits under must agree on a language before a mismatch is
    // a mismatch. A concept shared between a JS topic and a Python one is genuinely
    // language-neutral, and its item is nobody's error.
    const implied = new Set<string>();
    for (const name of topicNames) {
      for (const [pattern, lang] of TOPIC_LANGUAGE) if (pattern.test(name)) implied.add(lang);
    }
    if (implied.size !== 1) continue;

    const expected = [...implied][0]!;
    const actual = detectLanguage(item) ?? "";
    if (actual === "") continue;                          // genuinely language-free
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

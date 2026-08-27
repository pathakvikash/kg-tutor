/** Scores the real adjudicator against the labelled pairs; needs a model key in the env. */
import { llmFromEnv } from "@kg/llm";
import { LLMAdjudicator } from "../src/adjudicate-llm.js";
import { formatReport, scoreAdjudicator } from "./score.js";

const llm = llmFromEnv();
if (!llm) {
  console.error("No model key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  process.exit(1);
}

const report = await scoreAdjudicator(new LLMAdjudicator(llm));
console.log(formatReport(report));
process.exit(report.falseSames.length > 0 ? 1 : 0);

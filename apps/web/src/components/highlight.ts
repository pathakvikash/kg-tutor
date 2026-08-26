import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import bash from "highlight.js/lib/languages/bash";

/**
 * Registered individually rather than importing the full bundle: highlight.js ships
 * nearly 200 grammars, and a learning app aimed at programming needs a handful.
 */
for (const [name, lang] of [
  ["javascript", javascript], ["typescript", typescript], ["python", python],
  ["json", json], ["css", css], ["xml", xml], ["sql", sql], ["bash", bash],
] as const) {
  hljs.registerLanguage(name, lang);
}

const ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", py3: "python",
  html: "xml", svg: "xml", vue: "xml",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  postgres: "sql", postgresql: "sql", psql: "sql",
};

export function resolveLanguage(raw?: string | null): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  const mapped = ALIASES[key] ?? key;
  return hljs.getLanguage(mapped) ? mapped : null;
}

/**
 * Returns highlighted HTML, or null when the language is unknown or highlighting fails.
 *
 * Null matters: the caller then renders the code as plain text rather than risking
 * mangled output. Highlighting is a readability improvement, never a correctness one,
 * so it must never be able to change what the learner sees the code as saying.
 */
export function highlight(code: string, language?: string | null): string | null {
  const lang = resolveLanguage(language);
  if (!lang) return null;
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

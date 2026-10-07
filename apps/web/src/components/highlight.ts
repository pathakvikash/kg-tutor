import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import sql from "highlight.js/lib/languages/sql";
import bash from "highlight.js/lib/languages/bash";

// Registered individually to keep the full highlight.js bundle out
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

export function highlight(code: string, language?: string | null): string | null {
  const lang = resolveLanguage(language);
  if (!lang) return null;
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

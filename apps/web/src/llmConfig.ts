import { useEffect, useState } from "react";

export type Provider = "openrouter" | "anthropic" | "openai" | "custom";
export interface LlmConfig {
  provider: Provider;
  baseUrl?: string;
  apiKey: string;
  small: string;
  strong: string;
}

const KEY = "kg-tutor:llm";
const listeners = new Set<(c: LlmConfig | null) => void>();
let current = read();

function read(): LlmConfig | null {
  // localStorage can throw, not just return empty, when site data is blocked
  try {
    const raw = localStorage.getItem(KEY);
    const c = raw ? (JSON.parse(raw) as Partial<LlmConfig>) : null;
    return c && c.provider && c.apiKey && c.small && c.strong ? (c as LlmConfig) : null;
  } catch {
    return null;
  }
}

function set(next: LlmConfig | null): void {
  current = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    /* an unsaved key still works for this tab */
  }
  for (const fn of listeners) fn(next);
}

export const getLlmConfig = (): LlmConfig | null => current;
export const saveLlmConfig = (cfg: LlmConfig): void => set(cfg);
export const forgetLlmConfig = (): void => set(null);

export function useLlmConfig(): LlmConfig | null {
  const [cfg, setCfg] = useState(current);
  useEffect(() => {
    listeners.add(setCfg);
    if (current !== cfg) setCfg(current);
    return () => { listeners.delete(setCfg); };
  }, [cfg]);
  return cfg;
}

/** Keys are printable ASCII, so btoa never sees a wide character */
export function llmHeaders(): Record<string, string> {
  return current ? { "x-llm-config": btoa(JSON.stringify(current)) } : {};
}

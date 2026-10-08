import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ADMIN_TOKEN_KEY, HttpError, api, type TierResult } from "../api";
import { Busy } from "../components/Busy";
import { useLearner } from "../learnerStore";
import {
  forgetLlmConfig,
  saveLlmConfig,
  useLlmConfig,
  type LlmConfig,
  type Provider,
} from "../llmConfig";

interface CatalogEntry {
  label: string;
  models: string[];
  note?: string;
  /** Optional so an older API build still parses; when present the server default wins */
  defaultSmall?: string;
  defaultStrong?: string;
}
interface Tiers {
  provider: string;
  small: string;
  strong: string;
}
interface Status {
  llm: string | null;
  embedding: string;
  stubEmbedding: boolean;
  degraded: boolean;
  caveats?: string[];
}
interface Settings {
  current: Tiers;
  catalog: Record<string, CatalogEntry>;
  status: Status;
}

type Feedback = {
  kind: "ok" | "partial" | "error";
  title: string;
  body?: string;
  remedy?: string | null;
  caveats?: string[];
};

const NONE = "none";

const DEFAULTS: Record<string, { small: string; strong: string }> = {
  "claude-code": { small: "haiku", strong: "sonnet" },
  anthropic: { small: "claude-haiku-4-5-20251001", strong: "claude-sonnet-5" },
  openai: { small: "gpt-4o-mini", strong: "gpt-4o" },
};

const REMEDY: Record<string, string> = {
  anthropic:
    "Set ANTHROPIC_API_KEY in the API's environment and restart it. " +
    "The key is read when the provider is constructed, so a process already running will not pick up a new one.",
  openai:
    "Set OPENAI_API_KEY (or LLM_API_KEY) in the API's environment and restart it. " +
    "The key is read when the provider is constructed, so a process already running will not pick up a new one.",
  "claude-code":
    "Install the Claude Code CLI on the machine running the API and check it is signed in, then restart the API.",
};

function describe(e: unknown): { title: string; remedy: string | null } {
  if (e instanceof HttpError) return { title: e.message, remedy: e.remedy };
  return {
    title: e instanceof Error ? e.message : String(e),
    remedy: "The server is not answering. Try again in a minute.",
  };
}

function parseLive(llm: string | null): Tiers | null {
  if (!llm) return null;
  const [provider = "", models = ""] = llm.split(":");
  const [small = "", strong = ""] = models.split("/");
  return { provider, small, strong };
}

function otherCaveats(caveats?: string[]): string[] {
  return (caveats ?? []).filter((c) => !c.startsWith("no model configured"));
}

function StateRow({
  label,
  saved,
  live,
  differs,
}: {
  label: string;
  saved: React.ReactNode;
  live: React.ReactNode;
  differs?: boolean;
}) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="mono">{saved}</td>
      <td className="mono">
        {live}
        {differs && <span className="chip set-differs">differs</span>}
      </td>
    </tr>
  );
}

function ServerDefault() {
  const [data, setData] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<{ title: string; remedy: string | null } | null>(null);
  const [provider, setProvider] = useState(NONE);
  const [small, setSmall] = useState("");
  const [strong, setStrong] = useState("");
  const [freeform, setFreeform] = useState({ small: false, strong: false });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const drafts = useRef<Record<string, { small: string; strong: string }>>({});
  const load = useCallback(async () => {
    const d = (await api.modelSettings()) as Settings;
    setData(d);
    setProvider(d.current.provider);
    setSmall(d.current.small);
    setStrong(d.current.strong);
    setFreeform({ small: false, strong: false });
    drafts.current = {};
    return d;
  }, []);

  const reload = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await load();
      setLoadError(null);
    } catch (e) {
      setLoadError(describe(e));
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (e) {
        setLoadError(describe(e));
      }
    })();
  }, [load]);

  const entry = data?.catalog?.[provider];
  const dirty =
    !!data &&
    (provider !== data.current.provider ||
      small !== data.current.small ||
      strong !== data.current.strong);

  const clearFeedback = () => {
    if (feedback) setFeedback(null);
  };

  const tiersFor = (next: string): { small: string; strong: string } => {
    const remembered = drafts.current[next];
    if (remembered) return remembered;
    if (data && next === data.current.provider) {
      return { small: data.current.small, strong: data.current.strong };
    }
    if (next === NONE) return { small: "", strong: "" };
    const cat = data?.catalog[next];
    const models = cat?.models ?? [];
    return {
      small: cat?.defaultSmall ?? DEFAULTS[next]?.small ?? models[0] ?? "",
      strong: cat?.defaultStrong ?? DEFAULTS[next]?.strong ?? models[models.length - 1] ?? "",
    };
  };

  const pickProvider = (next: string) => {
    clearFeedback();
    if (data) drafts.current[provider] = { small, strong };
    const tiers = tiersFor(next);
    setProvider(next);
    setSmall(tiers.small);
    setStrong(tiers.strong);
    setFreeform({ small: false, strong: false });
  };

  const setTier = (tier: "small" | "strong", value: string) => {
    clearFeedback();
    if (tier === "small") setSmall(value);
    else setStrong(value);
  };

  const confirmation = (fresh: Settings): Feedback => {
    if (fresh.current.provider === NONE) {
      return {
        kind: "ok",
        title: "Saved. Model calls are off.",
        body:
          "Lessons, grading and graph expansion will now refuse to run rather than guess. " +
          "The graph, your plan and everything already learned are untouched.",
      };
    }
    if (!fresh.status.llm) {
      // A 2xx is not evidence of a working model, so the copy must not promise one
      return {
        kind: "partial",
        title: "Saved, but not usable yet.",
        body: "The API accepted the change and still reports no model loaded.",
        remedy: REMEDY[fresh.current.provider] ?? null,
        caveats: otherCaveats(fresh.status.caveats),
      };
    }
    return {
      kind: "ok",
      title: "Saved.",
      body: `${fresh.status.llm} is loaded. It takes effect on the next model call, with no restart.`,
    };
  };

  const save = async () => {
    // aria-disabled rather than disabled: disabling the pressed control drops focus to body
    if (busy || !dirty) return;
    setBusy(true);
    setFeedback(null);
    try {
      await api.setModel({ provider, small, strong });
      const fresh = await load().catch(() => null);
      setFeedback(
        fresh
          ? confirmation(fresh)
          : {
              kind: "partial",
              title: "Saved, but the page could not re-read the settings.",
              body: "The write went through; what is shown below may be stale.",
            },
      );
    } catch (e) {
      if (e instanceof HttpError && e.status === 422) {
        // The route persists first, so a 422 means the provider on disk already changed
        const fresh = await load().catch(() => null);
        setFeedback({
          kind: "partial",
          title: "Saved, but not usable yet.",
          body: e.message,
          remedy: e.remedy ?? REMEDY[provider] ?? null,
          caveats: otherCaveats(fresh?.status.caveats),
        });
      } else {
        const d = describe(e);
        setFeedback({ kind: "error", title: "Could not save.", body: d.title, remedy: d.remedy });
      }
    } finally {
      setBusy(false);
    }
  };

  const revert = () => {
    if (!data || !dirty) return;
    setFeedback(null);
    setProvider(data.current.provider);
    setSmall(data.current.small);
    setStrong(data.current.strong);
    setFreeform({ small: false, strong: false });
    drafts.current = {};
  };

  if (!data) {
    return loadError ? (
      <div className="notice notice--error" role="alert">
        <strong>The server default could not be read.</strong>
        <p>{loadError.title}</p>
        {loadError.remedy && <p className="set-remedy">{loadError.remedy}</p>}
        <div className="row set-actions">
          <button onClick={() => void reload()} aria-disabled={busy}>
            Retry
          </button>
          {busy && <Busy label="retrying" clock={false} />}
        </div>
      </div>
    ) : (
      <>
        <p className="sr-only" role="status">
          Reading the server default.
        </p>
        <div className="panel stack" aria-hidden="true">
          <div className="skeleton skeleton--line skeleton--w40" />
          <div className="skeleton skeleton--line skeleton--w80" />
          <div className="skeleton skeleton--line skeleton--w60" />
        </div>
      </>
    );
  }

  const status = data.status;
  const live = parseLive(status.llm);
  const savedProviderLabel =
    data.current.provider === NONE
      ? "no model"
      : (data.catalog[data.current.provider]?.label ?? data.current.provider);
  const caveats = otherCaveats(status.caveats);

  const tierField = (tier: "small" | "strong", label: string, purpose: string) => {
    const value = tier === "small" ? small : strong;
    const models = entry?.models ?? [];
    const savedHere = data.current.provider === provider ? data.current[tier] : "";
    const options = models.map((m) => ({ id: m, label: m }));
    // A select with no matching option renders blank, so pinned and custom ids are added
    if (savedHere && !models.includes(savedHere)) {
      options.push({ id: savedHere, label: `${savedHere} (from the environment)` });
    }
    if (value && !options.some((o) => o.id === value)) {
      options.push({ id: value, label: `${value} (custom)` });
    }
    return (
      <div className="set-field">
        <label htmlFor={`tier-${tier}`}>{label}</label>
        <p className="set-hint" id={`tier-${tier}-hint`}>
          {purpose}
        </p>
        {freeform[tier] ? (
          <input
            id={`tier-${tier}`}
            className="set-custom"
            value={value}
            aria-describedby={`tier-${tier}-hint`}
            placeholder="model id"
            onChange={(e) => setTier(tier, e.target.value)}
          />
        ) : (
          <select
            id={`tier-${tier}`}
            value={value}
            aria-describedby={`tier-${tier}-hint`}
            onChange={(e) => setTier(tier, e.target.value)}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="linkish set-fine"
          onClick={() => setFreeform((f) => ({ ...f, [tier]: !f[tier] }))}
        >
          {freeform[tier] ? "choose from the list" : "type a model id that is not listed"}
        </button>
      </div>
    );
  };

  return (
    <div className="stack--loose set-page">
        <section className="stack" aria-labelledby="set-state">
          <h2 className="set-h2" id="set-state">
            Current state
          </h2>

          {!status.llm ? (
            <div className="notice notice--warn">
              <strong>No model is configured.</strong>
              <p>
                Lessons, grading and graph expansion refuse to run until one is set below.
                This is deliberate: a fabricated concept is worse than a clear failure.
                Browsing the graph and everything already learned is unaffected.
              </p>
            </div>
          ) : (
            status.degraded && (
              <div className="notice notice--warn">
                <strong>Running degraded.</strong>
                <p>
                  A model is loaded, but something under it is a stub. Anything the app
                  reports about semantic matching describes the stub, not live behaviour.
                </p>
              </div>
            )
          )}

          <div className="panel table-wrap">
            <table className="set-table">
              <thead>
                <tr>
                  <th scope="col">Setting</th>
                  <th scope="col">Saved</th>
                  <th scope="col">In use now</th>
                </tr>
              </thead>
              <tbody>
                <StateRow
                  label="Provider"
                  saved={savedProviderLabel}
                  live={live?.provider ?? "none"}
                  differs={!!live && live.provider !== data.current.provider}
                />
                <StateRow
                  label="Small tier"
                  saved={data.current.small || "none"}
                  live={live?.small || "none"}
                  differs={!!live && live.small !== data.current.small}
                />
                <StateRow
                  label="Strong tier"
                  saved={data.current.strong || "none"}
                  live={live?.strong || "none"}
                  differs={!!live && live.strong !== data.current.strong}
                />
                <StateRow
                  label="Embeddings"
                  saved={<span className="muted">not set here</span>}
                  live={status.embedding + (status.stubEmbedding ? " (stub)" : "")}
                />
              </tbody>
            </table>
          </div>
          <p className="muted set-fine">
            “In use now” is what the API constructed when it last reloaded its settings, not
            a probe: a provider can be built successfully and still fail on its first call.
          </p>

          {caveats.length > 0 && (
            <>
              <h3 className="eyebrow">Caveats</h3>
              <ul className="muted set-caveats">
                {caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="stack" aria-labelledby="set-change">
          <h2 className="set-h2" id="set-change">
            Change the model
          </h2>
          <form
            className="panel stack--loose"
            aria-busy={busy}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="set-field">
              <label htmlFor="set-provider">Provider</label>
              {entry?.note && (
                <p className="set-hint" id="set-provider-hint">
                  {entry.note}
                </p>
              )}
              <select
                id="set-provider"
                value={provider}
                aria-describedby={entry?.note ? "set-provider-hint" : undefined}
                onChange={(e) => pickProvider(e.target.value)}
              >
                <optgroup label="Providers">
                  {Object.entries(data.catalog).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Off">
                  <option value={NONE}>No model</option>
                </optgroup>
              </select>
            </div>

            {provider === NONE ? (
              <div className="notice notice--info">
                <strong>With no model, the teaching half of the app stops.</strong>
                <p>
                  Explanations, grading, chat and graph expansion all refuse to run.
                  Browsing the graph, the plan and past transcripts keeps working.
                </p>
              </div>
            ) : (
              <>
                {tierField(
                  "small",
                  "Small tier",
                  "Grading, failure-mode classification and chat routing. Narrow, rubric-bound work.",
                )}
                {tierField(
                  "strong",
                  "Strong tier",
                  "Graph expansion, explanation adaptation and novel diagnosis.",
                )}
              </>
            )}

            {/* A live region inserted together with its text is not reliably announced */}
            <div className="set-feedback">
              <div role="status" aria-live="polite" aria-atomic="true">
                {feedback && feedback.kind !== "error" && (
                  <div
                    className={`notice ${feedback.kind === "ok" ? "notice--ok" : "notice--warn"}`}
                  >
                    <strong>{feedback.title}</strong>
                    {feedback.body && <p>{feedback.body}</p>}
                    {feedback.remedy && <p className="set-remedy">{feedback.remedy}</p>}
                    {feedback.caveats && feedback.caveats.length > 0 && (
                      <ul className="set-caveats">
                        {feedback.caveats.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
              <div role="alert">
                {feedback?.kind === "error" && (
                  <div className="notice notice--error">
                    <strong>{feedback.title}</strong>
                    {feedback.body && <p>{feedback.body}</p>}
                    {feedback.remedy && <p className="set-remedy">{feedback.remedy}</p>}
                  </div>
                )}
              </div>
            </div>

            <div className="row set-actions">
              <button type="submit" className="primary" aria-disabled={busy || !dirty}>
                Save
              </button>
              <button type="button" onClick={revert} aria-disabled={busy || !dirty}>
                Revert
              </button>
              {busy ? (
                <Busy label="saving" clock={false} />
              ) : (
                <span className="muted set-fine">{dirty ? "Unsaved changes." : "Nothing to save."}</span>
              )}
            </div>
          </form>
        </section>

        <details className="panel set-why">
          <summary>Why there are two tiers</summary>
          <p>
            The <strong>small</strong> tier handles grading, failure-mode classification and
            chat routing. This is narrow, rubric-bound work where a large model is more likely to
            charitably reinterpret a bad answer into a good one. The <strong>strong</strong>{" "}
            tier handles graph expansion, explanation adaptation and novel diagnosis.
          </p>
        </details>
    </div>
  );
}

function SetElsewhere() {
  const [learnerId] = useLearner();
  const [learners, setLearners] = useState<any[] | "loading" | "failed">("loading");
  useEffect(() => {
    void api.learners().then(setLearners).catch(() => setLearners("failed"));
  }, []);

  return (
        <section className="stack" aria-labelledby="set-elsewhere">
          <h2 className="set-h2" id="set-elsewhere">
            Set elsewhere
          </h2>
          <p className="muted set-fine">
            These behave like settings but are edited where they are used.
          </p>
          <div className="panel table-wrap">
            <table className="set-table">
              <tbody>
                <tr>
                  <th scope="row">Learner</th>
                  <td>
                    {learners === "loading" ? (
                      <span className="skeleton skeleton--line skeleton--w60" />
                    ) : learners === "failed" ? (
                      <span className="muted">could not be read</span>
                    ) : (
                      (() => {
                        const l = learners.find((x) => x.id === learnerId);
                        return l ? (l.email ?? l.name ?? l.id) : "none selected";
                      })()
                    )}
                  </td>
                  <td>
                    <Link to="/">Change on Home</Link>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Code language</th>
                  <td>
                    {learners === "loading" ? (
                      <span className="skeleton skeleton--line skeleton--w40" />
                    ) : learners === "failed" ? (
                      <span className="muted">could not be read</span>
                    ) : (
                      (learners.find((l) => l.id === learnerId)?.workingLanguage || (
                        <span className="muted">unset, so examples pick their own language</span>
                      ))
                    )}
                  </td>
                  <td>
                    <Link to="/">Change on Home</Link>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
  );
}

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "openrouter", label: "OpenRouter" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "custom", label: "Custom (OpenAI-compatible)" },
];
const labelOf = (p: Provider) => PROVIDERS.find((x) => x.id === p)?.label ?? p;

interface Form {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  small: string;
  strong: string;
}
const EMPTY: Form = { provider: "openrouter", baseUrl: "", apiKey: "", small: "", strong: "" };
const toForm = (c: LlmConfig | null): Form => (c ? { ...EMPTY, ...c, baseUrl: c.baseUrl ?? "" } : EMPTY);
const toConfig = (f: Form): LlmConfig => ({
  provider: f.provider,
  ...(f.provider === "custom" ? { baseUrl: f.baseUrl.trim() } : {}),
  apiKey: f.apiKey,
  small: f.small.trim(),
  strong: f.strong.trim(),
});

// Same limits as the server, so a bad value fails here with a plain message
const KEY_RE = /^[\x21-\x7e]{8,512}$/;
const MODEL_RE = /^[\x21-\x7e]{1,200}$/;

function connectionProblem(f: Form): string | null {
  if (f.provider === "custom" && !/^https:\/\/\S+$/i.test(f.baseUrl.trim())) {
    return "The base URL must start with https://.";
  }
  if (!KEY_RE.test(f.apiKey)) {
    return "Enter the API key as one piece, with no spaces (at least 8 characters).";
  }
  return null;
}

function configProblem(f: Form): string | null {
  const c = toConfig(f);
  if (!MODEL_RE.test(c.small) || !MODEL_RE.test(c.strong)) {
    return "Choose a model id for both tiers. Ids have no spaces.";
  }
  return connectionProblem(f);
}

type Note = { kind: "ok" | "warn" | "error"; title: string; lines?: string[] };

function failedNote(title: string, e: unknown): Note {
  const d = describe(e);
  return { kind: "error", title, lines: [d.title, d.remedy ?? ""].filter(Boolean) };
}

function NoteView({ note }: { note: Note }) {
  return (
    <div className={`notice notice--${note.kind}`}>
      <strong>{note.title}</strong>
      {note.lines?.map((l, i) => <p key={i}>{l}</p>)}
    </div>
  );
}

function YourModel() {
  const saved = useLlmConfig();
  const [form, setForm] = useState<Form>(() => toForm(saved));
  const [show, setShow] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [working, setWorking] = useState<"models" | "test" | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  // The last config where both tiers answered; reloading forgets it, so saved keys read "untested"
  const [verified, setVerified] = useState("");

  const patch = (p: Partial<Form>) => {
    setNote(null);
    setForm((f) => ({ ...f, ...p }));
  };

  const pickProvider = (provider: Provider) => {
    setNote(null);
    setModels([]);
    setForm(saved?.provider === provider ? toForm(saved) : { ...EMPTY, provider });
  };

  const fetchModels = async () => {
    if (working) return;
    const bad = connectionProblem(form);
    if (bad) return setNote({ kind: "error", title: bad });
    setWorking("models");
    setNote(null);
    try {
      const { provider, baseUrl, apiKey } = toConfig(form);
      const r = await api.llmModels({ provider, baseUrl, apiKey });
      setModels(r.models);
      setNote(
        r.models.length > 0
          ? { kind: "ok", title: `${r.models.length} models loaded. Pick one for each tier.` }
          : { kind: "warn", title: "The provider listed no models. Type the ids yourself." },
      );
    } catch (e) {
      setNote(failedNote("Could not fetch models.", e));
    } finally {
      setWorking(null);
    }
  };

  const test = async () => {
    if (working) return;
    const bad = configProblem(form);
    if (bad) return setNote({ kind: "error", title: bad });
    const cfg = toConfig(form);
    setWorking("test");
    setNote(null);
    try {
      const r = await api.llmTest(cfg);
      const line = (name: string, model: string, t: TierResult) =>
        t.ok ? `${name} (${model}): answered in ${t.ms} ms.` : `${name} (${model}): ${t.error}`;
      const ok = r.small.ok && r.strong.ok;
      if (ok) setVerified(JSON.stringify(cfg));
      setNote({
        kind: ok ? "ok" : "warn",
        title: ok ? "Both tiers answered." : "A tier did not answer.",
        lines: [line("Small", cfg.small, r.small), line("Strong", cfg.strong, r.strong)],
      });
    } catch (e) {
      setNote(failedNote("The test could not run.", e));
    } finally {
      setWorking(null);
    }
  };

  const save = () => {
    const bad = configProblem(form);
    if (bad) return setNote({ kind: "error", title: bad });
    const cfg = toConfig(form);
    saveLlmConfig(cfg);
    setNote({
      kind: "ok",
      title:
        JSON.stringify(cfg) === verified
          ? "Saved in this browser."
          : "Saved in this browser. It has not been tested.",
    });
  };

  const forget = () => {
    forgetLlmConfig();
    setForm(EMPTY);
    setModels([]);
    setVerified("");
    setNote({ kind: "ok", title: "Forgotten. This browser no longer holds a key." });
  };

  const isCustom = form.provider === "custom";
  const tested = !!saved && JSON.stringify(saved) === verified;
  const modelInput = (tier: "small" | "strong", label: string, hint: string) => (
    <div className="set-field">
      <label htmlFor={`llm-${tier}`}>{label}</label>
      <p className="set-hint" id={`llm-${tier}-hint`}>{hint}</p>
      <input
        id={`llm-${tier}`}
        className="set-custom"
        list="llm-models"
        value={form[tier]}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={`llm-${tier}-hint`}
        placeholder={models.length > 0 ? "choose or type a model id" : "model id"}
        onChange={(e) => patch({ [tier]: e.target.value })}
      />
    </div>
  );

  return (
    <section className="stack" aria-labelledby="set-mine">
      <h2 className="set-h2" id="set-mine">Your model</h2>
      <p className="muted set-copy">
        The key stays in this browser. It is sent with each request to the kg-tutor API, which
        uses it for that request only and never stores or logs it. Anyone with access to this
        browser profile can read it, so use a key with a spending limit.
      </p>
      <form
        className="panel stack--loose"
        aria-busy={working !== null}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="set-field">
          <label htmlFor="llm-provider">Provider</label>
          <select
            id="llm-provider"
            value={form.provider}
            onChange={(e) => pickProvider(e.target.value as Provider)}
          >
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>

        {isCustom && (
          <div className="set-field">
            <label htmlFor="llm-base">Base URL</label>
            <p className="set-hint" id="llm-base-hint">
              The /v1 root of an OpenAI-compatible API. It must be https and a host name, not an IP address.
            </p>
            <input
              id="llm-base"
              type="url"
              className="set-custom"
              value={form.baseUrl}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="llm-base-hint"
              placeholder="https://host/v1"
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
          </div>
        )}

        <div className="set-field">
          <label htmlFor="llm-key">API key</label>
          <div className="row set-keyrow">
            <input
              id="llm-key"
              className="set-custom"
              type={show ? "text" : "password"}
              value={form.apiKey}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ apiKey: e.target.value })}
            />
            <button type="button" aria-pressed={show} onClick={() => setShow((s) => !s)}>
              {show ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        <div className="row set-actions">
          <button type="button" onClick={() => void fetchModels()} aria-disabled={working !== null}>
            Fetch models
          </button>
          {working === "models" && <Busy label="fetching models" slowLabel="still fetching models" clock={false} />}
        </div>
        <datalist id="llm-models">
          {models.map((m) => <option key={m} value={m} />)}
        </datalist>

        {modelInput("small", "Small tier", "Grading and chat routing. A fast, cheap model is fine.")}
        {modelInput("strong", "Strong tier", "Explanations and graph expansion. Use your best model.")}

        <div className="row set-actions">
          <button type="button" onClick={() => void test()} aria-disabled={working !== null}>
            Test connection
          </button>
          {working === "test" && <Busy label="testing both tiers" slowLabel="still waiting for the provider" clock={false} />}
        </div>

        {/* A live region inserted together with its text is not reliably announced */}
        <div className="set-feedback">
          <div role="status" aria-live="polite" aria-atomic="true">
            {note && note.kind !== "error" && <NoteView note={note} />}
          </div>
          <div role="alert">{note?.kind === "error" && <NoteView note={note} />}</div>
        </div>

        <div className="row set-actions">
          <button type="submit" className="primary">Save</button>
          <button type="button" onClick={forget} aria-disabled={!saved && !form.apiKey}>
            Forget
          </button>
          <span className="muted set-fine">
            {saved
              ? `Saved: ${labelOf(saved.provider)}, ${saved.small} and ${saved.strong}. ${tested ? "Tested." : "Untested."}`
              : "Nothing saved. The server default is used."}
          </span>
        </div>
      </form>
    </section>
  );
}

function AdminToken() {
  const read = () => {
    try {
      return sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
    } catch {
      return "";
    }
  };
  const [saved, setSaved] = useState(read);
  const [value, setValue] = useState("");

  const store = (token: string) => {
    try {
      if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
      else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    } catch {
      /* without storage the token cannot be kept; admin actions will say so */
    }
    setSaved(token);
    setValue("");
  };

  return (
    <form
      className="set-field"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) store(value.trim());
      }}
    >
      <label htmlFor="set-admin-token">Admin token</label>
      <p className="set-hint" id="set-admin-token-hint">
        Needed for admin actions such as changing the server default or curating the graph.
        Kept in this tab only.
      </p>
      <div className="row set-keyrow">
        <input
          id="set-admin-token"
          className="set-custom"
          type="password"
          value={value}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="set-admin-token-hint"
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="primary" aria-disabled={!value.trim()}>Use token</button>
        <button type="button" onClick={() => store("")} aria-disabled={!saved}>Clear</button>
      </div>
      <p className="muted set-fine" role="status">
        {saved ? "A token is set for this tab." : "No token set."}
      </p>
    </form>
  );
}

export function SettingsPage() {
  return (
    <div className="page settings">
      <div className="page--narrow stack--loose set-page">
        <header className="stack--tight">
          <h1 className="set-title">Settings</h1>
          <p className="muted">Choose the model that runs your lessons.</p>
        </header>

        <YourModel />

        <details className="panel set-admin">
          <summary>Server default (admin)</summary>
          <p className="muted set-fine">
            Used when this browser has no key. Changing it affects everyone who has not set their own.
          </p>
          <AdminToken />
          <ServerDefault />
        </details>

        <SetElsewhere />
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HttpError, api } from "../api";
import { Busy } from "../components/Busy";
import { useLearner } from "../learnerStore";

interface CatalogEntry {
  label: string;
  models: string[];
  note?: string;
  /** Not sent by the route yet; read here so a server-side default wins as soon as it is. */
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
  /** "partial" is the saved-but-inert half-state, which is neither of the other two. */
  kind: "ok" | "partial" | "error";
  title: string;
  body?: string;
  remedy?: string | null;
  caveats?: string[];
};

const NONE = "none";

/**
 * Explicit per-provider defaults.
 *
 * The tiers were assigned positionally — models[0] and models[length - 1] — so picking a
 * provider promoted the strong tier to the most expensive entry in its catalogue, and did
 * it again every time you glanced at another provider and came back. CATALOG carries no
 * defaults field, so they live here until the route sends them.
 */
const DEFAULTS: Record<string, { small: string; strong: string }> = {
  "claude-code": { small: "haiku", strong: "sonnet" },
  anthropic: { small: "claude-haiku-4-5-20251001", strong: "claude-sonnet-5" },
  openai: { small: "gpt-4o-mini", strong: "gpt-4o" },
};

/**
 * What to actually do about a provider that saved but did not load.
 *
 * The 422 body sends `error` and no `remedy`, though api.ts joins the two precisely
 * because the remedy is the point of an auth failure — and it names neither the variable
 * nor the restart, which is required, since the key is read when the provider is
 * constructed. A server-sent remedy wins over these.
 */
const REMEDY: Record<string, string> = {
  anthropic:
    "Set ANTHROPIC_API_KEY in the API's environment and restart it — e.g. ANTHROPIC_API_KEY=… pnpm dev. " +
    "The key is read when the provider is constructed, so a process already running will not pick up a new one.",
  openai:
    "Set OPENAI_API_KEY (or LLM_API_KEY) in the API's environment and restart it. " +
    "The key is read when the provider is constructed, so a process already running will not pick up a new one.",
  "claude-code":
    "Install the Claude Code CLI on the machine running the API and check it is signed in, then restart the API.",
};

/** Zod's flatten() arrives as an object, and an object rendered as prose is a blob. */
function fieldErrors(message: string): string | null {
  try {
    const parsed = JSON.parse(message) as {
      formErrors?: string[];
      fieldErrors?: Record<string, string[]>;
    };
    const parts = [
      ...(parsed.formErrors ?? []),
      ...Object.entries(parsed.fieldErrors ?? {}).map(([f, msgs]) => `${f}: ${msgs.join(", ")}`),
    ];
    return parts.length > 0 ? parts.join(" · ") : null;
  } catch {
    return null;
  }
}

function describe(e: unknown): { title: string; remedy: string | null } {
  if (e instanceof HttpError) {
    return { title: fieldErrors(e.message) ?? e.message, remedy: e.remedy };
  }
  // A fetch that never lands throws a bare TypeError, which says nothing actionable.
  return {
    title: e instanceof Error ? e.message : String(e),
    remedy: "Check that the API is running on :4000 — pnpm dev starts it.",
  };
}

/**
 * The provider's own name string, "anthropic:small/strong".
 *
 * It is the only evidence of what the running process actually constructed, which is a
 * different claim from what is on disk — and the two disagree in exactly the case this
 * page exists to repair.
 */
function parseLive(llm: string | null): Tiers | null {
  if (!llm) return null;
  const [provider = "", models = ""] = llm.split(":");
  const [small = "", strong = ""] = models.split("/");
  return { provider, small, strong };
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

/**
 * Where the model configuration is repaired.
 *
 * Ordered status-first: the page is reached from a badge reading "no model — click to
 * set", so what the API is running on is the reason anyone is here. The form is second,
 * and the two-tier rationale — worth keeping — is third, behind a disclosure.
 */
export function SettingsPage() {
  const [data, setData] = useState<Settings | null>(null);
  /** Distinct from `data === null`: "we have not asked yet" is not "the read failed". */
  const [loadError, setLoadError] = useState<{ title: string; remedy: string | null } | null>(null);
  const [provider, setProvider] = useState(NONE);
  const [small, setSmall] = useState("");
  const [strong, setStrong] = useState("");
  /** Per tier: the select has been swapped for a free-text id. */
  const [freeform, setFreeform] = useState({ small: false, strong: false });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  /** Tiers chosen for a provider the user then navigated away from, so coming back
      restores that edit rather than resetting it. */
  const drafts = useRef<Record<string, { small: string; strong: string }>>({});
  const [learnerId] = useLearner();
  const [learners, setLearners] = useState<any[] | "loading" | "failed">("loading");

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
    // Without a failure path the page that exists to repair a broken model configuration
    // showed "Loading…" for ever, exactly when the backend is the broken thing.
    void (async () => {
      try {
        await load();
      } catch (e) {
        setLoadError(describe(e));
      }
    })();
  }, [load]);

  useEffect(() => {
    void api.learners().then(setLearners).catch(() => setLearners("failed"));
  }, []);

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
    // What the user last had for this provider wins, then what is on disk. Either way an
    // environment-pinned id survives a look at another provider rather than being
    // silently overwritten by a positional default.
    const remembered = drafts.current[next];
    if (remembered) return remembered;
    if (data && next === data.current.provider) {
      return { small: data.current.small, strong: data.current.strong };
    }
    if (next === NONE) return { small: "", strong: "" };
    const cat = data?.catalog[next];
    const models = cat?.models ?? [];
    return {
      // Positional only as a last resort, for a provider this build has never heard of.
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
      // A 2xx is not evidence of a working model, so the copy must not promise one:
      // "no restart needed" is only true when a provider actually came back.
      return {
        kind: "partial",
        title: "Saved, but not usable yet.",
        body: "The API accepted the change and still reports no model loaded.",
        remedy: REMEDY[fresh.current.provider] ?? null,
        caveats: fresh.status.caveats ?? [],
      };
    }
    return {
      kind: "ok",
      title: "Saved.",
      body: `${fresh.status.llm} is loaded — it takes effect on the next model call, with no restart.`,
    };
  };

  const save = async () => {
    // aria-disabled plus an early return, not disabled: disabling the control that was
    // just pressed blurs focus to <body>. The early return is what stops a no-op from
    // reporting success against a form nobody changed.
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
        // The route persists first and reports the missing key second, so by the time
        // this arrives the provider on disk has already changed. Collapsing it into a
        // failure left the form showing the new provider, the table showing the old one,
        // and every model route returning 503.
        const fresh = await load().catch(() => null);
        setFeedback({
          kind: "partial",
          title: "Saved, but not usable yet.",
          body: e.message,
          remedy: e.remedy ?? REMEDY[provider] ?? null,
          caveats: fresh?.status.caveats ?? [],
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
    return (
      <div className="page settings">
        <div className="page--narrow stack--loose">
          <h1 className="set-title">Settings</h1>
          {loadError ? (
            <div className="notice notice--error" role="alert">
              <strong>The model settings could not be read.</strong>
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
                Reading the model settings.
              </p>
              <div className="panel stack" aria-hidden="true">
                <div className="skeleton skeleton--line skeleton--w40" />
                <div className="skeleton skeleton--line skeleton--w80" />
                <div className="skeleton skeleton--line skeleton--w60" />
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const status = data.status;
  const live = parseLive(status.llm);
  const savedProviderLabel =
    data.current.provider === NONE
      ? "no model"
      : (data.catalog[data.current.provider]?.label ?? data.current.provider);
  // Stated in plain terms in the banner above the table instead; the server's own
  // phrasing for this one names an HTTP status the learner never sees.
  const caveats = (status.caveats ?? []).filter((c) => !c.startsWith("no model configured"));

  const tierField = (tier: "small" | "strong", label: string, purpose: string) => {
    const value = tier === "small" ? small : strong;
    const models = entry?.models ?? [];
    const savedHere = data.current.provider === provider ? data.current[tier] : "";
    const options = models.map((m) => ({ id: m, label: m }));
    // A <select> with no matching <option> renders blank, which is how an id pinned
    // through the environment showed as nothing while the table below printed it.
    if (savedHere && !models.includes(savedHere)) {
      options.push({ id: savedHere, label: `${savedHere} — from the environment` });
    }
    if (value && !options.some((o) => o.id === value)) {
      options.push({ id: value, label: `${value} — custom` });
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
    <div className="page settings">
      <div className="page--narrow stack--loose">
        <header className="stack--tight">
          <h1 className="set-title">Settings</h1>
          <p className="muted">What the API is running on, and how to change it.</p>
        </header>

        <section className="stack" aria-labelledby="set-state">
          <h2 className="set-h2" id="set-state">
            Current state
          </h2>

          {!status.llm ? (
            <div className="notice notice--warn">
              <strong>No model is configured.</strong>
              <p>
                Lessons, grading and graph expansion refuse to run until one is set below —
                deliberately, since a fabricated concept is worse than a clear failure.
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
                  saved={data.current.small || "—"}
                  live={live?.small || "—"}
                  differs={!!live && live.small !== data.current.small}
                />
                <StateRow
                  label="Strong tier"
                  saved={data.current.strong || "—"}
                  live={live?.strong || "—"}
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
              {/* Outside the label on purpose: as part of the accessible name this was
                  announced on every focus and every change, and clicking the variable
                  name — the one string anyone wants to copy — opened the dropdown. */}
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
                  "Grading, failure-mode classification and chat routing — narrow, rubric-bound work.",
                )}
                {tierField(
                  "strong",
                  "Strong tier",
                  "Graph expansion, explanation adaptation and novel diagnosis.",
                )}
              </>
            )}

            {/* Two regions, one source of truth. Both exist before anything is put in
                them — a live region inserted together with its text is not reliably
                announced, and one that was display:none is worse — and the single
                `feedback` state makes it impossible for a stale success to sit next to a
                fresh failure. The wrapper is the flex item, so an empty slot costs one
                gap rather than two. */}
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
            chat routing — narrow, rubric-bound work where a large model is more likely to
            charitably reinterpret a bad answer into a good one. The <strong>strong</strong>{" "}
            tier handles graph expansion, explanation adaptation and novel diagnosis.
          </p>
        </details>

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
                      (learners.find((l) => l.id === learnerId)?.email ?? "none selected")
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
                        <span className="muted">unset — examples pick their own language</span>
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
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Busy } from "../components/Busy";
import { HttpError, api, apiUrl } from "../api";

type Async<T> =
  | { phase: "loading" }
  | { phase: "ready"; data: T }
  | { phase: "failed"; error: Error };

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/** For the two calls api.ts has no wrapper for; same HttpError shape */
async function reviewFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(url), init);
  if (!res.ok) {
    const text = await res.text();
    let remedy: string | null = null;
    let message = text;
    try {
      const body = JSON.parse(text) as { error?: unknown; remedy?: string; detail?: string };
      remedy = body.remedy ?? null;
      message =
        typeof body.error === "string"
          ? body.error
          : body.error
            ? JSON.stringify(body.error)
            : body.detail ?? text;
    } catch { /* keep the raw text */ }
    throw new HttpError(res.status, message || `HTTP ${res.status}`, remedy);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const getNegative = (minAttempts: number) =>
  reviewFetch<any>(`/api/review/negative?minAttempts=${minAttempts}`);

const reverseProposal = (id: string, reason: string) =>
  reviewFetch<{ retired: number }>(`/api/review/proposals/${id}/reverse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });

/* Accept writes a hard edge unconditionally, so only new_hard_edge is acceptable */
const KIND: Record<string, { label: string; blurb: string; acceptable: boolean }> = {
  new_hard_edge: {
    label: "new hard edge",
    blurb: "Writes a provisional prerequisite edge, named failure mode attached.",
    acceptable: true,
  },
  remove_edge: {
    label: "remove edge",
    blurb: "Retires an existing edge. Accepting it here would write one instead.",
    acceptable: false,
  },
  flip_strength: {
    label: "flip strength",
    blurb: "Moves an edge between hard and soft. No control for it here yet.",
    acceptable: false,
  },
  split_concept: {
    label: "split concept",
    blurb: "Splits one concept in two. No control for it here yet.",
    acceptable: false,
  },
  retire_failure_mode: {
    label: "retire failure mode",
    blurb: "Drops a failure mode nobody exhibits. No control for it here yet.",
    acceptable: false,
  },
};

const kindOf = (kind: string) =>
  KIND[kind] ?? { label: kind.replace(/_/g, " "), blurb: "Unknown kind — read only here.", acceptable: false };

const BAR = { effect: 0.2, learners: 12, goals: 2 };

/* Mirrors checkFailureMode in @kg/shared; advisory only, the server still decides */
const VAGUE = [
  /\b(?:won'?t|will not|can'?t|cannot|couldn'?t|doesn'?t|does not|unable to)\s+(?:really\s+|fully\s+|properly\s+|truly\s+)?(?:understand|grasp|get|follow|learn|make sense of)\b/i,
  /\bwill(?: be)?\s+(?:get\s+)?confus(?:ed|ing)\b/i,
  /\bwill struggle\b/i,
  /\blacks?\s+(?:the\s+)?(?:foundation|basics|background|groundwork)\b/i,
  /\bis\s+(?:a\s+)?(?:necessary|required|essential|fundamental)\s+(?:prerequisite|foundation|building block)\b/i,
  /\bneeds?\s+to\s+know\s+(?:this|it|that)\s+first\b/i,
  /\bit'?s\s+(?:important|fundamental|foundational|essential)\b/i,
];
const MIN_WORDS = 6;
const wordsIn = (s: string) => s.toLowerCase().split(/\W+/).filter(Boolean);

type FmFault = "empty" | "too_short" | "circular" | "restates_target" | "vague";

function checkFailureMode(
  text: string,
  src: string | null,
  dst: string | null,
): { fault: FmFault | null; words: number } {
  const t = text.trim();
  const count = wordsIn(t).length;
  if (count === 0) return { fault: "empty", words: 0 };
  if (count < MIN_WORDS) return { fault: "too_short", words: count };

  const lower = t.toLowerCase();
  const s = (src ?? "").trim().toLowerCase();
  const d = (dst ?? "").trim().toLowerCase();
  if (s && lower.includes(s) && wordsIn(lower.split(s).join(" ")).length < MIN_WORDS) {
    return { fault: "circular", words: count };
  }
  if (d && lower.includes(d) && wordsIn(lower.split(d).join(" ")).length < MIN_WORDS) {
    return { fault: "restates_target", words: count };
  }
  if (VAGUE.some((re) => re.test(t))) return { fault: "vague", words: count };
  return { fault: null, words: count };
}

function faultHelp(fault: FmFault, words: number, src: string | null, dst: string | null): string {
  switch (fault) {
    case "empty":
      return "A hard edge is only accepted with a concrete failure mode named.";
    case "too_short":
      return `${words} word${words === 1 ? "" : "s"} — six is the minimum, because six is about the shortest a real mistake can be described in.`;
    case "circular":
      return `This only names ${src ?? "the prerequisite"} back. Say what the learner gets wrong without it.`;
    case "restates_target":
      return `This only names ${dst ?? "the target"} back. Describe the mistake, not the topic.`;
    case "vague":
      return "Phrasings like “won't understand”, “will struggle” or “is essential” assert a failure without describing one.";
  }
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const plainName = (n: string | null) => (!n || UUID.test(n) ? "an unnamed concept" : n);

/** The route falls back to a raw id when a concept row is gone; a uuid is not a name */
function ConceptName({ name }: { name: string | null }) {
  if (!name) return <span className="cur-nil">none</span>;
  if (UUID.test(name)) return <span className="cur-nil">deleted concept {name.slice(0, 8)}</span>;
  return <>{name}</>;
}

function EdgePair({ src, dst }: { src: string | null; dst: string | null }) {
  return (
    <span className="cur-pair">
      <ConceptName name={src} />
      <span className="cur-to" aria-hidden="true"> → </span>
      <span className="sr-only"> is a prerequisite of </span>
      <ConceptName name={dst} />
    </span>
  );
}

function Failed({ what, error, onRetry }: { what: string; error: Error; onRetry: () => void }) {
  const remedy = error instanceof HttpError ? error.remedy : null;
  return (
    <div className="notice notice--error" role="alert">
      <strong>{what} could not be loaded.</strong>
      <p className="cur-err-msg">{error.message}</p>
      {remedy && <p className="cur-err-msg">{remedy}</p>}
      <button onClick={onRetry}>Retry</button>
    </div>
  );
}

function Placeholder({ rows = 3, what }: { rows?: number; what?: string }) {
  const widths = ["skeleton--w80", "skeleton--w60", "skeleton--w40"];
  return (
    <div className="cur-sk" aria-busy="true">
      <p className="sr-only">{what ? `Loading ${what.toLowerCase()}…` : "Loading…"}</p>
      <div aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className={`skeleton skeleton--line ${widths[i % widths.length]}`} />
        ))}
      </div>
    </div>
  );
}

function Loaded<T>({
  res, what, onRetry, rows, children,
}: {
  res: Async<T>;
  what: string;
  onRetry: () => void;
  rows?: number;
  children: (data: T) => React.ReactNode;
}) {
  if (res.phase === "loading") return <Placeholder rows={rows} what={what} />;
  if (res.phase === "failed") return <Failed what={what} error={res.error} onRetry={onRetry} />;
  return <>{children(res.data)}</>;
}

function Meter({
  label, value, target, format,
}: {
  label: string;
  value: number;
  target: number;
  format: (n: number) => string;
}) {
  const met = value >= target;
  const fill = Math.max(0, Math.min(1, value / (target * 2)));
  return (
    <div className="cur-meter">
      <span className="eyebrow">{label}</span>
      <span className={met ? "cur-meter-v is-met" : "cur-meter-v"}>{format(value)}</span>
      <span className="cur-bar" aria-hidden="true">
        <span className={met ? "cur-bar-fill is-met" : "cur-bar-fill"} style={{ width: `${fill * 100}%` }} />
        <span className="cur-bar-tick" />
      </span>
      <span className="cur-meter-t">{met ? "meets" : "below"} {format(target)}</span>
    </div>
  );
}

function RateShift({
  without, withIt, effect,
}: {
  without: number | null;
  withIt: number | null;
  effect: number;
}) {
  if (without === null || withIt === null) {
    return (
      <p className="cur-shift-t">
        Failure rates were not recorded for this proposal; effect size {effect.toFixed(2)}.
      </p>
    );
  }
  return (
    <div className="cur-shift">
      <span className="cur-rate">{pct(without)}</span>
      <span className="cur-to" aria-hidden="true">→</span>
      <span className="sr-only">falls to</span>
      <span className="cur-rate is-low">{pct(withIt)}</span>
      <span className="cur-shift-t">
        failure rate at the target without the prerequisite → with it
      </span>
    </div>
  );
}

/* No retire-edge endpoint yet, so a reviewed row is only hidden in this browser */
const DISMISS_KEY = "kg-tutor.curate.dismissed";

function readDismissed(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch { return {}; }
}

export function ReviewPage() {
  const [proposals, setProposals] = useState<Async<any[]>>({ phase: "loading" });
  const [queue, setQueue] = useState<Async<any[]>>({ phase: "loading" });
  const [negative, setNegative] = useState<Async<any>>({ phase: "loading" });

  const [failureModes, setFailureModes] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<Record<string, "reject" | "reverse" | null>>({});
  const [reverseReason, setReverseReason] = useState<Record<string, string>>({});

  const [busy, setBusy] = useState<{ op: string; label: string } | null>(null);
  const [scanNote, setScanNote] = useState<
    { tone: "ok" | "error"; text: string; nearMisses: any[] } | null
  >(null);
  const [outcome, setOutcome] = useState<{ text: string; token: number } | null>(null);

  const [minAttempts, setMinAttempts] = useState(30);
  const [queueLimit, setQueueLimit] = useState(25);
  const [dismissed, setDismissed] = useState<Record<string, string>>(readDismissed);
  const [showDismissed, setShowDismissed] = useState(false);

  const fmRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const outcomeRef = useRef<HTMLDivElement | null>(null);

  const loadProposals = useCallback(async () => {
    setProposals({ phase: "loading" });
    try { setProposals({ phase: "ready", data: await api.proposals() }); }
    catch (e) { setProposals({ phase: "failed", error: asError(e) }); }
  }, []);

  const loadQueue = useCallback(async () => {
    setQueue({ phase: "loading" });
    try { setQueue({ phase: "ready", data: await api.reviewQueue() }); }
    catch (e) { setQueue({ phase: "failed", error: asError(e) }); }
  }, []);

  const loadNegative = useCallback(async (min: number) => {
    setNegative({ phase: "loading" });
    try { setNegative({ phase: "ready", data: await getNegative(min) }); }
    catch (e) { setNegative({ phase: "failed", error: asError(e) }); }
  }, []);

  useEffect(() => { void loadProposals(); void loadQueue(); }, [loadProposals, loadQueue]);
  useEffect(() => { void loadNegative(minAttempts); }, [loadNegative, minAttempts]);

  useEffect(() => { if (outcome) outcomeRef.current?.focus(); }, [outcome]);

  const locked = busy !== null;
  const announce = (text: string) => setOutcome({ text, token: Date.now() });

  const refreshAll = () => {
    if (locked) return;
    void loadProposals(); void loadQueue(); void loadNegative(minAttempts);
  };

  const scan = async () => {
    if (locked) return;
    setBusy({ op: "scan", label: "scanning evidence for missing edges" });
    setScanNote(null);
    try {
      const r = await api.scan();
      /* Split on rejectedFor: proposed is also false for an open proposal that was re-checked */
      const misses = r.results.filter((x: any) => (x.rejectedFor ?? []).length > 0);
      const passed = r.results.filter((x: any) => (x.rejectedFor ?? []).length === 0);
      const fresh = passed.filter((x: any) => x.proposed).length;
      setScanNote({
        tone: "ok",
        text:
          `Scanned ${r.scanned} candidate edge${r.scanned === 1 ? "" : "s"}; ` +
          `${passed.length} met the bar and ${misses.length} did not.` +
          (passed.length > 0
            ? ` ${fresh} new proposal${fresh === 1 ? "" : "s"}, ` +
              `${passed.length - fresh} already open and re-checked against current evidence.`
            : ""),
        nearMisses: misses,
      });
      await loadProposals();
    } catch (e) {
      const err = asError(e);
      const remedy = err instanceof HttpError && err.remedy ? ` ${err.remedy}` : "";
      setScanNote({ tone: "error", text: `${err.message}${remedy}`, nearMisses: [] });
    } finally { setBusy(null); }
  };

  const accept = async (p: any) => {
    if (locked) return;
    const text = failureModes[p.id] ?? "";
    const { fault, words } = checkFailureMode(text, p.src, p.dst);
    if (fault) {
      setRowError({ ...rowError, [p.id]: faultHelp(fault, words, p.src, p.dst) });
      fmRefs.current[p.id]?.focus();
      return;
    }
    setBusy({ op: `accept:${p.id}`, label: "writing the provisional edge" });
    setRowError({ ...rowError, [p.id]: "" });
    try {
      await api.acceptProposal(p.id, text.trim());
      announce(
        `Accepted. A provisional hard edge now exists from ${plainName(p.src)} to ` +
        `${plainName(p.dst)}; ` +
        "reverse it below if it turns out wrong.",
      );
      await loadProposals();
      void loadQueue();
    } catch (e) {
      const err = asError(e);
      setRowError({ ...rowError, [p.id]: serverFailureMessage(err) });
      fmRefs.current[p.id]?.focus();
    } finally { setBusy(null); }
  };

  const reject = async (p: any) => {
    if (locked) return;
    setBusy({ op: `reject:${p.id}`, label: "recording the rejection" });
    setRowError({ ...rowError, [p.id]: "" });
    try {
      await api.rejectProposal(p.id);
      setConfirming({ ...confirming, [p.id]: null });
      announce(
        `Rejected the proposal for ${plainName(p.src)} → ${plainName(p.dst)}. ` +
        "No edge was written.",
      );
      await loadProposals();
    } catch (e) {
      setRowError({ ...rowError, [p.id]: asError(e).message });
    } finally { setBusy(null); }
  };

  const reverse = async (p: any) => {
    if (locked) return;
    const reason = (reverseReason[p.id] ?? "").trim();
    setBusy({ op: `reverse:${p.id}`, label: "retiring the promoted edge" });
    setRowError({ ...rowError, [p.id]: "" });
    try {
      const r = await reverseProposal(p.id, reason || "reversed from Curate");
      setConfirming({ ...confirming, [p.id]: null });
      announce(
        r.retired === 0
          ? "Nothing to retire — this proposal has no live edge."
          : `Retired ${r.retired} edge${r.retired === 1 ? "" : "s"} promoted by this proposal.`,
      );
      await loadProposals();
      void loadQueue();
    } catch (e) {
      setRowError({ ...rowError, [p.id]: asError(e).message });
    } finally { setBusy(null); }
  };

  const dismiss = (edgeId: string, reason: string) => {
    const next = { ...dismissed, [edgeId]: reason || "reviewed, no action" };
    setDismissed(next);
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };
  const undismiss = (edgeId: string) => {
    const next = { ...dismissed };
    delete next[edgeId];
    setDismissed(next);
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };

  const open = proposals.phase === "ready" ? proposals.data.filter((p) => p.status === "open") : [];
  const decided = proposals.phase === "ready" ? proposals.data.filter((p) => p.status !== "open") : [];
  const count = (res: Async<any[]>, n: number) => (res.phase === "ready" ? ` (${n})` : "");
  const inventionCount =
    negative.phase === "ready"
      ? ` (${[...(negative.data.unobserved ?? []), ...(negative.data.bypassed ?? [])]
          .filter((r: any) => !dismissed[r.edgeId]).length})`
      : "";

  return (
    <div className="page page--table cur">
      <header className="cur-head">
        <h1>Curate</h1>
        <p className="cur-lead">
          The review surface for the shared graph — what every future learner gets taught
          from, not one learner's progress.
        </p>
      </header>

      <div className="notice notice--info">
        Structural changes are proposals, never automatic writes. Accepting one requires a
        concrete failure mode and produces a <em>provisional</em> edge, which stays
        reversible from the Decided list below.
      </div>

      <div className="cur-actions row">
        <button
          className="primary"
          onClick={() => void scan()}
          aria-disabled={locked}
        >
          Scan evidence for missing edges
        </button>
        <button onClick={refreshAll} aria-disabled={locked}>Refresh all three lists</button>
        {busy?.op === "scan" && <Busy label={busy.label} />}
      </div>
      <p className="cur-note">
        Scan re-reads every learner's evidence for prerequisite edges the graph does not
        have, and tests each one against a control arm. It is the slowest operation here
        and it only ever creates proposals — it never writes an edge.
      </p>

      {scanNote && (
        <div
          className={scanNote.tone === "ok" ? "notice notice--ok" : "notice notice--error"}
          role={scanNote.tone === "ok" ? "status" : "alert"}
        >
          <strong>{scanNote.tone === "ok" ? "Scan finished" : "Scan failed"}</strong>
          <p className="cur-err-msg">{scanNote.text}</p>
          {scanNote.nearMisses.length > 0 && (
            <details className="cur-misses">
              <summary>Near misses ({scanNote.nearMisses.length})</summary>
              <ul>
                {scanNote.nearMisses.map((m: any, i: number) => (
                  <li key={`${m.prerequisiteId}-${m.targetId}-${i}`}>
                    <span className="cur-miss-why">
                      {(m.rejectedFor ?? []).join("; ") || "did not pass the control comparison"}
                    </span>
                    <span className="cur-miss-meta mono">
                      effect {Number(m.effectSize ?? 0).toFixed(2)} ·{" "}
                      {m.spontaneousRequests} asked unprompted
                    </span>
                    <span className="cur-miss-links">
                      <Link to={`/graph?node=${m.prerequisiteId}&hops=1`}>prerequisite in graph</Link>
                      <Link to={`/graph?node=${m.targetId}&hops=1`}>target in graph</Link>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <h2 className="section-title">Open proposals{count(proposals, open.length)}</h2>
      <p className="cur-sub">
        A proposal needs {BAR.learners} distinct learners across {BAR.goals} goals and an
        effect of at least {BAR.effect.toFixed(2)} between the two arms before it appears.
      </p>

      <Loaded res={proposals} what="Proposals" onRetry={() => void loadProposals()} rows={4}>
        {() =>
          open.length === 0 ? (
            <div className="empty">
              Nothing pending. A proposal appears when learners repeatedly behave as though
              an edge exists <em>and</em> the control comparison supports it.
            </div>
          ) : (
            <div className="cur-proposals">
              {open.map((p) => {
                const kind = kindOf(p.kind);
                const hasEnds = Boolean(p.src && p.dst);
                /* applyProposal refuses a proposal whose ends are gone; Accept must not show */
                const endsLive = hasEnds && !UUID.test(p.src) && !UUID.test(p.dst);
                const canAccept = kind.acceptable && endsLive;
                const text = failureModes[p.id] ?? "";
                const check = checkFailureMode(text, p.src, p.dst);
                const err = rowError[p.id];
                const runningAccept = busy?.op === `accept:${p.id}`;
                const runningReject = busy?.op === `reject:${p.id}`;
                return (
                  <article className="panel cur-card" key={p.id}>
                    <div className="head cur-card-head">
                      <h3 className="cur-edge">
                        {p.src || p.dst ? <EdgePair src={p.src} dst={p.dst} /> : "Unnamed proposal"}
                      </h3>
                      <span className={kind.acceptable ? "chip hard" : "chip"}>{kind.label}</span>
                    </div>
                    <p className="cur-kind-blurb">{kind.blurb}</p>

                    <div className="cur-evidence">
                      <RateShift
                        without={p.treatmentFailureRate}
                        withIt={p.controlFailureRate}
                        effect={p.effectSize}
                      />
                      <div className="cur-meters">
                        <Meter label="effect" value={p.effectSize} target={BAR.effect}
                          format={(n) => n.toFixed(2)} />
                        <Meter label="learners" value={p.distinctLearners} target={BAR.learners}
                          format={(n) => String(n)} />
                        <Meter label="goals" value={p.distinctGoals} target={BAR.goals}
                          format={(n) => String(n)} />
                      </div>
                      <p className="cur-claim">{p.claim}</p>
                    </div>

                    {canAccept ? (
                      <div className="cur-fm">
                        <label className="cur-fm-label" htmlFor={`fm-${p.id}`}>
                          Failure mode
                        </label>
                        <p className="cur-contract">
                          What specifically goes wrong without <ConceptName name={p.src} />? Six
                          words or more, describing the wrong belief or wrong behaviour — not
                          that the prerequisite is needed, and not{" "}
                          <ConceptName name={p.src} /> or <ConceptName name={p.dst} /> named
                          back at itself.
                        </p>
                        <textarea
                          id={`fm-${p.id}`}
                          rows={3}
                          className="cur-fm-input"
                          ref={(el) => { fmRefs.current[p.id] = el; }}
                          aria-describedby={`fm-check-${p.id}`}
                          aria-invalid={Boolean(err) || undefined}
                          value={text}
                          onChange={(e) =>
                            setFailureModes({ ...failureModes, [p.id]: e.target.value })
                          }
                        />
                        <p className="cur-fm-check" id={`fm-check-${p.id}`}>
                          {check.fault === null
                            ? `${check.words} words — reads like a real failure mode.`
                            : check.fault === "empty"
                              ? "Required before this can be accepted."
                              : faultHelp(check.fault, check.words, p.src, p.dst)}
                        </p>
                      </div>
                    ) : (
                      <p className="notice notice--warn">
                        {!hasEnds
                          ? "This proposal has no source or target concept on record, so no edge can be written from it."
                          : !endsLive
                            ? "One end of this proposal is a concept that no longer exists, so no edge can be written from it. Reject it — the graph has moved on since it was raised."
                            : "This kind cannot be executed from here — Accept would write a hard edge, which is not what it proposes. Reject it, or act on it directly in the graph."}
                      </p>
                    )}

                    {err && (
                      <p className="notice notice--error" role="alert">{err}</p>
                    )}

                    <div className="cur-card-actions">
                      {canAccept && (
                        <>
                          <button
                            className="primary"
                            onClick={() => void accept(p)}
                            aria-disabled={locked || check.fault !== null}
                          >
                            Accept
                          </button>
                          {runningAccept && <Busy label={busy!.label} clock={false} />}
                        </>
                      )}
                      <div className="cur-reject">
                        <button
                          className="linkish danger"
                          aria-expanded={confirming[p.id] === "reject"}
                          onClick={() =>
                            setConfirming({
                              ...confirming,
                              [p.id]: confirming[p.id] === "reject" ? null : "reject",
                            })
                          }
                        >
                          Reject this proposal…
                        </button>
                        {confirming[p.id] === "reject" && (
                          <div className="notice notice--warn cur-confirm" role="status">
                            <strong>Rejecting is permanent.</strong>
                            <p className="cur-err-msg">
                              The proposal cannot be reopened; the same evidence would have to
                              be scanned again to produce a new one.
                            </p>
                            <div className="row">
                              <button onClick={() => void reject(p)} aria-disabled={locked}>
                                Confirm reject
                              </button>
                              {runningReject && <Busy label={busy!.label} clock={false} />}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )
        }
      </Loaded>

      {outcome && (
        <div
          className="notice notice--ok cur-outcome"
          role="status"
          tabIndex={-1}
          ref={outcomeRef}
          key={outcome.token}
        >
          {outcome.text}
        </div>
      )}

      <h2 className="section-title">Decided{count(proposals, decided.length)}</h2>
      <p className="cur-sub">
        What has already been ruled on. An accepted proposal wrote a provisional edge, and
        retiring that edge is a normal operation rather than an incident.
      </p>
      <Loaded res={proposals} what="Proposals" onRetry={() => void loadProposals()} rows={2}>
        {() =>
          decided.length === 0 ? (
            <div className="empty">Nothing decided yet.</div>
          ) : (
            <div className="cur-decided">
              {decided.map((p) => {
                const err = rowError[p.id];
                const running = busy?.op === `reverse:${p.id}`;
                return (
                  <div className="panel panel--tight cur-decision" key={p.id}>
                    <div className="head">
                      <span className="cur-edge-sm">
                        <EdgePair src={p.src} dst={p.dst} />
                      </span>
                      <span className="row row--tight">
                        <span className="chip">{kindOf(p.kind).label}</span>
                        <span className={p.status === "accepted" ? "chip prov" : "chip"}>
                          {p.status}
                        </span>
                      </span>
                    </div>
                    <p className="cur-decision-meta mono">
                      effect {Number(p.effectSize).toFixed(2)} · {p.distinctLearners} learners ·{" "}
                      {p.distinctGoals} goals
                    </p>
                    {p.status === "accepted" && (
                      <>
                        <button
                          className="linkish danger"
                          aria-expanded={confirming[p.id] === "reverse"}
                          onClick={() =>
                            setConfirming({
                              ...confirming,
                              [p.id]: confirming[p.id] === "reverse" ? null : "reverse",
                            })
                          }
                        >
                          Reverse…
                        </button>
                        {confirming[p.id] === "reverse" && (
                          <div className="notice notice--warn cur-confirm" role="status">
                            <strong>Retires the edge this proposal wrote.</strong>
                            <p className="cur-err-msg">
                              The edge is retired with a reason, never deleted, and the
                              proposal goes back to rejected.
                            </p>
                            <label className="cur-fm-label" htmlFor={`rev-${p.id}`}>
                              Why (recorded on the edge)
                            </label>
                            <input
                              id={`rev-${p.id}`}
                              className="cur-reason"
                              value={reverseReason[p.id] ?? ""}
                              placeholder="e.g. learners keep succeeding without it"
                              onChange={(e) =>
                                setReverseReason({ ...reverseReason, [p.id]: e.target.value })
                              }
                            />
                            <div className="row">
                              <button onClick={() => void reverse(p)} aria-disabled={locked}>
                                Retire the edge
                              </button>
                              {running && <Busy label={busy!.label} clock={false} />}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                    {err && <p className="notice notice--error" role="alert">{err}</p>}
                  </div>
                );
              })}
            </div>
          )
        }
      </Loaded>

      <div className="head cur-section-head">
        <div>
          <h2 className="section-title">Looks like invention{inventionCount}</h2>
          <p className="cur-sub">
            The graph starts as model assertion, so pruning fiction is worth more early
            than adding more claims. Nothing here can be retired automatically: acting on a
            row means editing that edge in the graph.
          </p>
        </div>
        <label className="field">
          Attempts before judging
          <select
            value={minAttempts}
            onChange={(e) => setMinAttempts(Number(e.target.value))}
          >
            <option value={10}>at least 10</option>
            <option value={30}>at least 30</option>
            <option value={60}>at least 60</option>
            <option value={120}>at least 120</option>
          </select>
        </label>
      </div>

      <Loaded res={negative} what="Negative evidence" onRetry={() => void loadNegative(minAttempts)} rows={3}>
        {(n) => {
          const unobserved = (n.unobserved ?? []).filter((u: any) => !dismissed[u.edgeId]);
          const bypassed = (n.bypassed ?? []).filter((b: any) => !dismissed[b.edgeId]);
          const hiddenHere = [...(n.unobserved ?? []), ...(n.bypassed ?? [])]
            .filter((r: any) => dismissed[r.edgeId])
            .map((r: any) => [r.edgeId, dismissed[r.edgeId]] as [string, string]);
          const hereIds = new Set(hiddenHere.map(([id]) => id));
          const elsewhere = Object.entries(dismissed).filter(([id]) => !hereIds.has(id));
          if (unobserved.length === 0 && bypassed.length === 0) {
            return (
              <>
                <div className="empty">
                  Nothing flagged at {minAttempts}+ attempts — or not enough traffic yet to
                  judge.
                </div>
                {hiddenHere.length + elsewhere.length > 0 && (
                  <DismissedList
                    here={hiddenHere}
                    elsewhere={elsewhere}
                    open={showDismissed}
                    onToggle={() => setShowDismissed(!showDismissed)}
                    onUndismiss={undismiss}
                  />
                )}
              </>
            );
          }
          return (
            <>
              <div className="table-wrap">
                <table className="cur-table">
                  <thead>
                    <tr><th>Edge</th><th>Signal</th><th>Detail</th><th>Reviewed</th></tr>
                  </thead>
                  <tbody>
                    {unobserved.map((u: any) => (
                      <tr key={u.edgeId}>
                        <td>
                          <Link to={`/graph?edge=${u.edgeId}`}>
                            <EdgePair src={u.srcName} dst={u.dstName} />
                          </Link>
                        </td>
                        <td className="mono">unobserved failure mode</td>
                        <td className="cur-detail">
                          {u.attempts} attempts, never once exhibited: “{u.failureMode}”
                        </td>
                        <td><DismissButton edgeId={u.edgeId} onDismiss={dismiss} /></td>
                      </tr>
                    ))}
                    {bypassed.map((b: any) => (
                      <tr key={b.edgeId}>
                        <td>
                          <Link to={`/graph?edge=${b.edgeId}`}>
                            <EdgePair src={b.srcName} dst={b.dstName} />
                          </Link>
                        </td>
                        <td className="mono">routinely bypassed</td>
                        <td className="cur-detail">
                          {pct(b.bypassRate)} of {b.total} learners succeeded without it
                        </td>
                        <td><DismissButton edgeId={b.edgeId} onDismiss={dismiss} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="cur-sub">
                Thresholds: a failure mode is flagged after {minAttempts}+ attempts at the
                target with none of them showing it; a prerequisite is flagged when 10 or
                more learners reached the target and over 70% never demonstrated it.
              </p>
              {hiddenHere.length + elsewhere.length > 0 && (
                <DismissedList
                  here={hiddenHere}
                  elsewhere={elsewhere}
                  open={showDismissed}
                  onToggle={() => setShowDismissed(!showDismissed)}
                  onUndismiss={undismiss}
                />
              )}
            </>
          );
        }}
      </Loaded>

      <h2 className="section-title">
        Review queue by traversal
        {queue.phase === "ready" ? ` (${queue.data.length}${queue.data.length === 100 ? "+" : ""})` : ""}
      </h2>
      <p className="cur-sub">
        Most of the graph is never crossed by anyone; reviewing that is wasted attention.
        Hard prerequisite edges only, provisional first, then by how many plans cross them.
      </p>
      <Loaded res={queue} what="The review queue" onRetry={() => void loadQueue()} rows={3}>
        {(rows) =>
          rows.length === 0 ? (
            <div className="empty">No hard edges yet.</div>
          ) : (
            <>
              <div className="table-wrap">
                <table className="cur-table">
                  <thead>
                    <tr><th>Edge</th><th>Plans crossing it</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, queueLimit).map((q) => (
                      <tr key={q.edgeId}>
                        <td>
                          <Link to={`/graph?edge=${q.edgeId}`}>
                            <EdgePair src={q.srcName} dst={q.dstName} />
                          </Link>
                        </td>
                        <td className="mono">{q.traversals}</td>
                        <td>
                          <span className={q.provisional ? "chip prov" : "chip"}>
                            {q.provisional ? "provisional" : "canonical"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > queueLimit && (
                <p className="cur-sub">
                  Showing {queueLimit} of {rows.length}
                  {rows.length === 100 ? " returned (the route caps at 100)" : ""} —{" "}
                  <button className="linkish" onClick={() => setQueueLimit(rows.length)}>
                    show all {rows.length}
                  </button>
                </p>
              )}
            </>
          )
        }
      </Loaded>
    </div>
  );
}

function serverFailureMessage(err: Error): string {
  const m = err.message;
  const reason = /failure mode rejected \((\w+)\)/.exec(m)?.[1];
  if (reason === "too_short") return "The server counted fewer than six words.";
  if (reason === "circular") return "The server read this as naming the prerequisite back at itself.";
  if (reason === "restates_target") return "The server read this as restating the target, not a mistake.";
  if (reason === "vague") return "The server read this as asserting a failure without describing one.";
  if (err instanceof HttpError && err.remedy) return `${m} — ${err.remedy}`;
  return m;
}

function DismissButton({
  edgeId, onDismiss,
}: {
  edgeId: string;
  onDismiss: (edgeId: string, reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <>
      <button className="linkish" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Keep it listed" : "Dismiss…"}
      </button>
      {open && (
        <div className="cur-dismiss">
          <input
            value={reason}
            placeholder="Why it is fine (kept in this browser)"
            onChange={(e) => setReason(e.target.value)}
          />
          <button onClick={() => { onDismiss(edgeId, reason); setOpen(false); }}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}

function DismissedList({
  here, elsewhere, open, onToggle, onUndismiss,
}: {
  here: [string, string][];
  elsewhere: [string, string][];
  open: boolean;
  onToggle: () => void;
  onUndismiss: (edgeId: string) => void;
}) {
  const rows = (entries: [string, string][]) => (
    <ul>
      {entries.map(([edgeId, reason]) => (
        <li key={edgeId}>
          <Link to={`/graph?edge=${edgeId}`}>edge {edgeId.slice(0, 8)}</Link>
          <span className="cur-detail">{reason}</span>
          <button className="linkish" onClick={() => onUndismiss(edgeId)}>restore</button>
        </li>
      ))}
    </ul>
  );
  const total = here.length + elsewhere.length;
  return (
    <div className="cur-dismissed">
      <button className="linkish" aria-expanded={open} onClick={onToggle}>
        {total} dismissed in this browser
      </button>
      {open && (
        <>
          {here.length > 0 && rows(here)}
          {elsewhere.length > 0 && (
            <>
              <p className="cur-detail cur-dismissed-note">
                {elsewhere.length === 1
                  ? "One dismissal is for an edge this list does not currently flag:"
                  : `${elsewhere.length} dismissals are for edges this list does not currently flag:`}
              </p>
              {rows(elsewhere)}
            </>
          )}
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, HttpError } from "../api";
import { Busy } from "../components/Busy";
import { MASTERY_ORDER } from "../vocabulary";

/**
 * Mirrors `crossSessionPersistence`'s minGapDays default. The entire meaning of
 * "cross-session" hangs on it and the API does not return it, so it is stated on screen
 * rather than left as a number only the server knows.
 */
const MIN_GAP_DAYS = 7;

/** Below this many learners an arm is one person's session, not a measurement. */
const ANECDOTE_MIN = 5;

/** The words for "we have not measured this", used wherever a value can be absent. */
const NOT_YET = "no data yet";

interface Rate {
  /** False when the denominator is empty: there is no rate, not a rate of zero. */
  measurable: boolean;
  value: number;
  n: number;
  d: number;
}

/**
 * The one place a ratio becomes a number.
 *
 * Three of the four rates here returned 0 for an empty denominator and printed a
 * confident "0%" over "0 bound / 0 proposals", so on a fresh install the page's own
 * stated falsification signal read as a refutation. The clamp is a backstop: the waste
 * numerator counts events against a denominator of distinct pairs, so it can exceed it,
 * and 130% is not a percentage anyone can act on.
 */
function rate(n: number, d: number): Rate {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) {
    return { measurable: false, value: 0, n, d: 0 };
  }
  return { measurable: true, value: Math.min(n / d, 1), n, d };
}

/**
 * Percentages by magnitude, and never 100% unless it is genuinely all of them:
 * toFixed(0) turned 99.6% into a claim that every proposal was reused.
 */
function pct(value: number, n?: number, d?: number): string {
  const complete = n !== undefined && d !== undefined && n >= d;
  if (value >= 1) return complete ? "100%" : ">99%";
  const p = value * 100;
  if (p >= 99.5) return ">99%";
  if (p === 0) return "0%";
  if (p < 0.5) return "<1%";
  return `${p < 10 ? p.toFixed(1) : p.toFixed(0)}%`;
}

const rateText = (r: Rate) => (r.measurable ? pct(r.value, r.n, r.d) : NOT_YET);

/**
 * Spend by magnitude. Fixed three decimals printed real sub-cent usage as "$0.000" — so
 * a purpose that definitely burned paid calls read as free — and would put fake
 * thousandths on a four-figure total.
 */
function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NOT_YET;
  if (n === 0) return "$0";
  if (n < 0.001) return "<$0.001";
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

const hhmm = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** meanMasteryRank is a 0–3 index into the mastery scale; on its own it means nothing. */
function levelFor(rank: number): string {
  const i = Math.max(0, Math.min(MASTERY_ORDER.length - 1, Math.round(rank)));
  return MASTERY_ORDER[i];
}

/**
 * A labelled number. dt/dd so label and value are paired programmatically rather than by
 * adjacency, and an absent value says so in words instead of an em dash that could
 * equally be a minus sign or a loading state.
 */
function Stat({ k, v, sub, empty }: { k: string; v: string; sub?: string; empty?: boolean }) {
  return (
    <div className="stat" {...(empty ? { "data-empty": "true" } : {})}>
      <dt className="k">{k}</dt>
      <dd className="v">
        {empty ? NOT_YET : v}
        {sub && <span className="sub">{sub}</span>}
      </dd>
    </div>
  );
}

function StatSkeleton() {
  return (
    <div className="stat">
      <div className="skeleton skeleton--line skeleton--w60" />
      <div className="skeleton stat-skel-v" />
      <div className="skeleton skeleton--line skeleton--w80" />
    </div>
  );
}

/** A table nobody has filled yet, said as what would fill it. */
const Empty = ({ children }: { children: ReactNode }) => (
  <div className="empty metrics-empty">{children}</div>
);

/**
 * What is actually weakened, derived from the fields, plus the API's own caveats.
 *
 * The hand-written sentence said "stub providers" (plural) whenever either half was
 * stubbed, so a real model with a stubbed embedding was reported as having no model at
 * all — and the caveats array, which exists precisely so the UI can be specific, was
 * fetched and dropped. Tone comes from .notice--warn rather than accent-coloured text,
 * which measured 3.98:1 in light mode.
 */
function DegradedNotice({ p }: { p: any }) {
  const reasons: string[] = [];
  if (!p.llm) reasons.push("no model is configured");
  if (p.stubEmbedding) reasons.push(`embeddings are the ${p.embedding} stub`);
  const lead = reasons.length ? reasons.join(", and ") : "the provider stack is degraded";
  const caveats: string[] = Array.isArray(p.caveats) ? p.caveats : [];

  return (
    <div className="notice notice--warn metrics-degraded">
      <strong>Degraded run{p.llm ? ` · model: ${p.llm}` : ""}</strong>
      <p>
        {lead.charAt(0).toUpperCase() + lead.slice(1)}.{" "}
        {/* Whether the numbers are real depends on whether a MODEL is real, not on
            whether anything at all is stubbed. With claude-code live and only the
            embedding stubbed, the spend below is money that was actually spent — and
            telling the reader to disregard an accurate figure is its own kind of wrong. */}
        {p.llm
          ? "The counts and costs below are from real calls; what is weakened is described above."
          : "Nothing here reflects live model behaviour — the numbers describe seeded and test data only."}
      </p>
      {caveats.length > 0 && (
        <ul className="metrics-caveats">
          {caveats.map((c) => <li key={c}>{c}</li>)}
        </ul>
      )}
    </div>
  );
}

function ErrorNotice({
  error, onRetry, busy,
}: { error: Error; onRetry: () => void; busy: boolean }) {
  const remedy = error instanceof HttpError ? error.remedy : null;
  return (
    <div className="notice notice--error metrics-error" role="alert">
      <strong>Metrics could not be loaded</strong>
      <p>
        {remedy ??
          "Nothing on this page can be computed without the API, so these figures are unknown rather than zero."}
      </p>
      <p className="mono metrics-detail">{error.message}</p>
      <div className="row">
        {/* Enabled with aria-disabled: disabling the control just pressed blurs focus
            to <body>. */}
        <button onClick={onRetry} aria-disabled={busy}>Retry</button>
        {busy && <Busy label="retrying" />}
      </div>
    </div>
  );
}

function Header({
  asOf, busy, onRefresh,
}: { asOf: Date | null; busy: boolean; onRefresh: () => void }) {
  return (
    <div className="head metrics-head">
      <div className="stack stack--tight">
        <h1 className="metrics-title">Metrics</h1>
        <p className="eyebrow">{asOf ? `as of ${hhmm(asOf)}` : "not loaded yet"}</p>
      </div>
      <div className="row">
        <button onClick={onRefresh} aria-disabled={busy}>Refresh</button>
        {busy && <Busy label="reading metrics" />}
      </div>
    </div>
  );
}

export function MetricsPage() {
  const [m, setM] = useState<any>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(true);
  const [asOf, setAsOf] = useState<Date | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    /**
     * /api/metrics gets slower the more the app is used — wastedTeaching reads every
     * evidence event and crossSessionPersistence issues one findFirst per re-probe — so
     * an unmount or a second Refresh landing mid-flight is the normal case, and the
     * earlier reply must not overwrite the later one.
     *
     * The signal gates the state writes only: `api.metrics()` takes no AbortSignal, so
     * the request itself still runs to completion. Threading one through would be a
     * one-word change in api.ts, which this page does not own.
     */
    const ctl = new AbortController();
    setBusy(true);
    api.metrics()
      .then((d) => {
        if (ctl.signal.aborted) return;
        setM(d);
        setError(null);
        setAsOf(new Date());
        setBusy(false);
      })
      .catch((e) => {
        if (ctl.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setBusy(false);
      });
    return () => ctl.abort();
  }, [nonce]);

  const refresh = useCallback(() => {
    if (busy) return;
    setNonce((n) => n + 1);
  }, [busy]);

  // Nothing has arrived yet. The shell stays and the placeholders say "not asked yet",
  // rather than a finished dashboard full of zeroes.
  if (!m) {
    return (
      <div className="page metrics">
        <div className="page--table">
          <Header asOf={asOf} busy={busy} onRefresh={refresh} />
          {error ? (
            <ErrorNotice error={error} onRetry={refresh} busy={busy} />
          ) : (
            <>
              <h2 className="section-title">Graph coverage</h2>
              <div className="stats">
                <StatSkeleton /><StatSkeleton /><StatSkeleton /><StatSkeleton />
              </div>
              <h2 className="section-title">Teaching</h2>
              <div className="stats">
                <StatSkeleton /><StatSkeleton /><StatSkeleton /><StatSkeleton />
              </div>
              <h2 className="section-title">Cost per verified outcome</h2>
              <div className="stats">
                <StatSkeleton /><StatSkeleton /><StatSkeleton />
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const reuse = rate(m.reuse.bound, m.reuse.proposals);
  const knewRate = rate(m.waste.alreadyKnew, m.waste.attempts);
  const persistence = rate(m.persistence.held, m.persistence.concepts);
  const taught: number = m.waste.attempts;

  const byPurpose: { purpose: string; costUsd: number; calls: number }[] = m.cost.byPurpose ?? [];
  const purposeSpend = byPurpose.reduce((a, p) => a + p.costUsd, 0);
  const purposeCalls = byPurpose.reduce((a, p) => a + p.calls, 0);
  const spendKnown = purposeSpend > 0;

  const arms: any[] = m.arms ?? [];
  const thinArms = arms.some((a) => a.learners < ANECDOTE_MIN);
  const reuseByTopic: any[] = m.reuseByTopic ?? [];

  return (
    <div className="page metrics">
      <div className="page--table">
        <Header asOf={asOf} busy={busy} onRefresh={refresh} />

        {/* A failed refresh over numbers already on screen: the timestamp above still
            names the load these figures came from. */}
        {error && <ErrorNotice error={error} onRetry={refresh} busy={busy} />}

        {m.providers.degraded && <DegradedNotice p={m.providers} />}

        <h2 className="section-title">Graph coverage</h2>
        <dl className="stats">
          <Stat k="concepts" v={String(m.graph.concepts)} />
          <Stat k="hard edges" v={String(m.graph.hardEdges)} sub={`${m.graph.softEdges} soft`} />
          <Stat
            k="reuse rate"
            v={rateText(reuse)}
            empty={!reuse.measurable}
            sub={
              reuse.measurable
                ? `${reuse.n} of ${reuse.d} proposals bound to a concept that already existed`
                : "no proposal has been adjudicated yet"
            }
          />
          <Stat
            k="learners"
            v={String(m.counts.learners)}
            sub={`${m.counts.evidence} evidence events`}
          />
        </dl>
        <p className="muted prose note">
          Reuse rate is the earliest falsification signal for the whole premise: if a second
          overlapping topic still creates almost entirely new concepts, the graph is not being
          shared, and that shows up in week one rather than month twelve.
        </p>

        <h2 className="section-title">Teaching</h2>
        {/* Was one "wasted teaching" rate that printed 130%: its numerator added every
            gap-diagnosed failed check (unbounded per concept) to a count of distinct
            first contacts, and it never showed its own denominator. Two numbers with two
            denominators, because they are two measurements. */}
        <dl className="stats">
          <Stat
            k="taught what they knew"
            v={rateText(knewRate)}
            empty={!knewRate.measurable}
            sub={
              knewRate.measurable
                ? `${knewRate.n} of ${knewRate.d} first contacts were an unaided transfer`
                : "nothing has been taught yet"
            }
          />
          <Stat
            k="taught into a gap"
            v={String(m.waste.taughtIntoGap)}
            empty={taught === 0}
            sub={
              taught === 0
                ? "nothing has been taught yet"
                : `failed checks diagnosed as a missing prerequisite, over ${taught} first contacts — a count, not a rate: one concept can fail repeatedly`
            }
          />
          <Stat
            k="cross-session persistence"
            v={rateText(persistence)}
            empty={!persistence.measurable}
            sub={
              persistence.measurable
                ? `${persistence.n} of ${persistence.d} re-probes held after a ${MIN_GAP_DAYS}-day gap`
                : `nothing has been re-probed after a ${MIN_GAP_DAYS}-day gap yet`
            }
          />
          <Stat k="open proposals" v={String(m.counts.openProposals)} />
        </dl>

        <h2 className="section-title">Cost per verified outcome</h2>
        <p className="eyebrow metrics-scope">all arms, all time</p>
        <dl className="stats">
          <Stat k="total spend" v={usd(m.cost.totalCostUsd)} />
          <Stat
            k="per concept mastered"
            v={usd(m.cost.costPerConceptMastered)}
            empty={m.cost.conceptsMastered === 0}
            sub={
              m.cost.conceptsMastered === 0
                ? "no concept has reached functional yet"
                : `${m.cost.conceptsMastered} mastered`
            }
          />
          <Stat
            k="per milestone"
            v={usd(m.cost.costPerMilestone)}
            empty={m.cost.milestonesCompleted === 0}
            sub={
              m.cost.milestonesCompleted === 0
                ? "no milestone has been completed yet"
                : `${m.cost.milestonesCompleted} completed`
            }
          />
        </dl>
        <p className="muted prose note">
          Per outcome, never per hour — cost per hour can be improved by teaching cheaply and
          badly. The hypothesis is that this falls as the graph and item bank accumulate,
          while the baseline arm stays flat forever.
        </p>
        <p className="muted prose note">
          These three figures cover every arm and every learner: usage is recorded without a
          learner or session, so spend cannot yet be split by arm, and the trend above cannot
          yet be checked against the baseline.
        </p>

        <h2 className="section-title">Cost by purpose</h2>
        {byPurpose.length === 0 ? (
          <Empty>No model calls recorded yet — one call to any purpose fills this in.</Empty>
        ) : (
          <>
            {!spendKnown && (
              <div className="notice notice--info note">
                Calls recorded at no cost, so there is no spend to apportion — a stub provider
                reports zero dollars per call.
              </div>
            )}
            {/* Focusable scroll region: the overflow container is otherwise unreachable
                by keyboard, and it is the only way to see the trailing columns at 380px. */}
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Cost by purpose">
              <table className="t-purpose">
                <thead>
                  <tr>
                    <th>Purpose</th>
                    <th className="num">Calls</th>
                    <th className="num">Cost</th>
                    <th className="num">% of spend</th>
                    <th className="num">Per call</th>
                  </tr>
                </thead>
                <tbody>
                  {byPurpose.map((p) => {
                    const share = rate(p.costUsd, purposeSpend);
                    return (
                      <tr key={p.purpose}>
                        <td className="mono">{p.purpose}</td>
                        <td className="num mono">{p.calls}</td>
                        <td className="num mono">{usd(p.costUsd)}</td>
                        <td className="num mono">{share.measurable ? pct(share.value) : "—"}</td>
                        <td className="num mono">
                          {usd(p.calls === 0 ? null : p.costUsd / p.calls)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {/* Here so the total does not have to be summed across fourteen rows in
                    the reader's head to be checked against the total-spend card. */}
                <tfoot>
                  <tr>
                    <th scope="row">All purposes</th>
                    <td className="num mono">{purposeCalls}</td>
                    <td className="num mono">{usd(purposeSpend)}</td>
                    <td className="num mono">{spendKnown ? "100%" : "—"}</td>
                    <td className="num mono">
                      {usd(purposeCalls === 0 ? null : purposeSpend / purposeCalls)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}

        <h2 className="section-title">Arms</h2>
        {arms.length === 0 ? (
          <Empty>No sessions yet — nothing to compare.</Empty>
        ) : (
          <>
            {thinArms && (
              <div className="notice notice--warn note">
                An arm with fewer than {ANECDOTE_MIN} learners is an anecdote rather than a
                measurement, so its per-learner figure is shown as the raw counts it came from.
              </div>
            )}
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Arm comparison">
              <table className="t-arms">
                <thead>
                  <tr>
                    <th>Variant</th>
                    <th className="num">Learners</th>
                    <th className="num">Mastered</th>
                    <th className="num">Per learner</th>
                    <th className="num">Mean mastery</th>
                  </tr>
                </thead>
                <tbody>
                  {arms.map((a: any) => (
                    <tr key={a.variant}>
                      <td>
                        <span className="mono">{a.variant}</span>
                        {a.variant === "baseline" && <span className="sub">control arm</span>}
                      </td>
                      {/* n is the loudest column: "12.00 per learner" from a single
                          learner reads as a measurement, and it is one session. */}
                      <td className="num mono n-cell">{a.learners}</td>
                      <td className="num mono">{a.conceptsMastered}</td>
                      <td className="num mono">
                        {a.learners < ANECDOTE_MIN
                          ? `${a.conceptsMastered} / ${a.learners}`
                          : a.masteredPerLearner.toFixed(2)}
                      </td>
                      <td className="num mono">
                        {a.meanMasteryRank.toFixed(2)}
                        <span className="sub">of 3 · {levelFor(a.meanMasteryRank)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <h2 className="section-title">Reuse by topic</h2>
        {reuseByTopic.length === 0 ? (
          <Empty>
            No adjudicated proposals yet — expanding a second overlapping topic fills this in,
            and it is where a thin corner of the graph shows up first.
          </Empty>
        ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Reuse by topic">
            <table>
              <thead>
                <tr>
                  <th>Topic</th>
                  <th className="num">Proposals</th>
                  <th className="num">Reuse</th>
                </tr>
              </thead>
              <tbody>
                {reuseByTopic.map((t: any) => {
                  // The API returns the rate, not the numerator; recovering it keeps the
                  // "never print 100% unless it is all of them" rule honest.
                  const r = rate(Math.round(t.reuseRate * t.proposals), t.proposals);
                  return (
                    <tr key={t.topic}>
                      <td>{t.topic}</td>
                      <td className="num mono">{t.proposals}</td>
                      <td className="num mono">{r.measurable ? pct(r.value, r.n, r.d) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

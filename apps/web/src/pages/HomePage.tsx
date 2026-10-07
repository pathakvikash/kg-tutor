import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, apiUrl, HttpError } from "../api";
import { Busy } from "../components/Busy";
import { Markdown } from "../components/Markdown";
import { DEPTH_LABEL, DUE_KIND, dueKindLabel } from "../vocabulary";
import { resolveLearner, useStickyLearner } from "../useLearner";
import { getLearner } from "../learnerStore";

const KINDS = Object.keys(DUE_KIND) as (keyof typeof DUE_KIND)[];

const ROWS = 8;

const CARDS = ["intake", "due", "plan"] as const;

const RECENT_MS = 12 * 60 * 60 * 1000;

const JOBS = 4;

type Outcome<T> =
  | { kind: "pending" }
  | { kind: "ok"; data: T }
  | { kind: "absent" }
  | Failure;

type Failure = { kind: "failed"; message: string; remedy: string | null };

const PENDING: { kind: "pending" } = { kind: "pending" };

function describe(e: unknown): { message: string; remedy: string | null } {
  if (e instanceof HttpError) return { message: e.message, remedy: e.remedy };
  return { message: e instanceof Error ? e.message : String(e), remedy: null };
}

function settle<T>(r: PromiseSettledResult<T>): Outcome<T> {
  if (r.status === "fulfilled") return { kind: "ok", data: r.value };
  const e: unknown = r.reason;
  if (e instanceof HttpError && e.isMissing) return { kind: "absent" };
  return { kind: "failed", ...describe(e) };
}

/** api.ts has no wrapper for POST /api/learners */
async function createLearner(email: string): Promise<{ id: string }> {
  const res = await fetch(apiUrl("/api/learners"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return res.json() as Promise<{ id: string }>;
}

function Placeholder() {
  return (
    <div aria-hidden="true">
      <div className="skeleton skeleton--line skeleton--w80" />
      <div className="skeleton skeleton--line skeleton--w60" />
    </div>
  );
}

function Failed({ what, at, onRetry }: { what: string; at: Failure; onRetry: () => void }) {
  return (
    <div className="notice notice--error" role="alert">
      <strong>Could not load {what}.</strong>
      <p className="home-fail-why">{at.remedy ?? at.message}</p>
      <button className="linkish" onClick={onRetry}>try again</button>
    </div>
  );
}

function CardHead({ title, lead, rank }: { title: string; lead: boolean; rank: string | null }) {
  return (
    <div className="row row--baseline home-card-head">
      <h3 className={lead ? "home-card-title" : "eyebrow"}>{title}</h3>
      {rank && (
        <span className="home-rank">
          {rank}
          <span className="sr-only">{rank === "now" ? " — do this first" : " — do this next"}</span>
        </span>
      )}
    </div>
  );
}

export function HomePage() {
  const [roster, setRoster] = useState<Outcome<any[]>>(PENDING);
  const [learnerId, setLearnerId] = useStickyLearner();
  const [due, setDue] = useState<Outcome<any>>(PENDING);
  const [plan, setPlan] = useState<Outcome<any>>(PENDING);
  const [intake, setIntake] = useState<Outcome<any>>(PENDING);

  const [jobs, setJobs] = useState<any[]>([]);
  const [jobsFailed, setJobsFailed] = useState<Failure | null>(null);
  const [retrying, setRetrying] = useState("");
  const tracked = useRef<Set<string>>(new Set());

  const [newEmail, setNewEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const [lang, setLang] = useState("");
  const [langFor, setLangFor] = useState("");
  const [save, setSave] = useState<{ kind: "idle" | "saving" | "ok" } | Failure>({ kind: "idle" });

  // A newer learner's reads must win, whichever order the two flights land in
  const flight = useRef(0);

  const loadRoster = useCallback(async () => {
    setRoster(PENDING);
    const [r] = await Promise.allSettled([api.learners()]);
    const outcome = settle(r);
    setRoster(outcome);
    if (outcome.kind === "ok") setLearnerId(resolveLearner(getLearner(), outcome.data));
  }, [setLearnerId]);

  useEffect(() => { void loadRoster(); }, [loadRoster]);

  const load = useCallback(async (id: string) => {
    const mine = ++flight.current;
    setDue(PENDING); setPlan(PENDING); setIntake(PENDING);
    if (!id) return;
    const [d, p, i] = await Promise.allSettled([api.due(id), api.plan(id), api.openIntake(id)]);
    if (flight.current !== mine) return;
    setDue(settle(d)); setPlan(settle(p)); setIntake(settle(i));
  }, []);

  useEffect(() => { void load(learnerId); }, [learnerId, load]);

  const syncJobs = useCallback(async () => {
    const [r] = await Promise.allSettled([api.expansions()]);
    if (r.status !== "fulfilled") {
      setJobsFailed({ kind: "failed", ...describe(r.reason) });
      return;
    }
    const now = Date.now();
    const keep = r.value.filter((j: any) => {
      if (tracked.current.has(j.id)) return true;
      if (j.status === "queued" || j.status === "running") return true;
      const at = Date.parse(j.finishedAt ?? j.createdAt ?? "");
      return Number.isFinite(at) && now - at < RECENT_MS;
    });
    // Tracked so it survives ageing out, and so tracked.size means a build was seen
    for (const j of keep) tracked.current.add(j.id);
    setJobs(keep.slice(0, JOBS));
    setJobsFailed(null);
  }, []);

  useEffect(() => { void syncJobs(); }, [syncJobs]);

  const jobsLive = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!jobsLive) return;
    const t = setInterval(() => { void syncJobs(); }, 3000);
    return () => clearInterval(t);
  }, [jobsLive, syncJobs]);

  const retryJob = useCallback(async (id: string) => {
    setRetrying(id);
    const [r] = await Promise.allSettled([api.retryExpansion(id)]);
    if (r.status === "fulfilled" && r.value?.id) tracked.current.add(r.value.id);
    if (r.status === "rejected") setJobsFailed({ kind: "failed", ...describe(r.reason) });
    await syncJobs();
    setRetrying("");
  }, [syncJobs]);

  const learners: any[] = roster.kind === "ok" ? roster.data : [];
  const noLearners = roster.kind === "absent" || (roster.kind === "ok" && learners.length === 0);
  const hasRoster = roster.kind === "ok" && learners.length > 0;
  const canShow = !!learnerId && !noLearners && roster.kind !== "pending";
  const serverLang: string = learners.find((l) => l.id === learnerId)?.workingLanguage ?? "";

  useEffect(() => {
    const record = learners.find((l) => l.id === learnerId);
    // Adopted once per learner; keying on `learners` would undo it after each save
    if (!record || langFor === learnerId) return;
    setLang(record.workingLanguage ?? "");
    setLangFor(learnerId);
    setSave({ kind: "idle" });
  }, [learnerId, learners, langFor]);

  const saveLang = useCallback(async () => {
    setSave({ kind: "saving" });
    const [r] = await Promise.allSettled([api.updateLearner(learnerId, { workingLanguage: lang })]);
    if (r.status === "rejected") {
      setSave({ kind: "failed", ...describe(r.reason) });
      return;
    }
    const [fresh] = await Promise.allSettled([api.learners()]);
    if (fresh.status === "fulfilled") setRoster({ kind: "ok", data: fresh.value });
    setSave({ kind: "ok" });
  }, [lang, learnerId]);

  const createNew = useCallback(async () => {
    const email = newEmail.trim();
    if (!email) return;
    setCreating(true); setCreateError("");
    const [r] = await Promise.allSettled([createLearner(email)]);
    if (r.status === "fulfilled") {
      await loadRoster();
      setLearnerId(r.value.id);
    } else {
      const d = describe(r.reason);
      // The route answers a bad address with a zod tree, which is not a sentence
      setCreateError(
        r.reason instanceof HttpError && r.reason.status === 400
          ? "That does not look like an email address."
          : d.remedy ?? d.message,
      );
    }
    setCreating(false);
  }, [loadRoster, newEmail, setLearnerId]);

  const dueData = due.kind === "ok" ? due.data : null;
  const dueTotal: number = dueData?.total ?? 0;
  const planData = plan.kind === "ok" ? plan.data : null;
  const nextStep = planData?.steps?.find((s: any) => !s.completed) ?? null;
  const openIntake = intake.kind === "ok" && intake.data?.intake ? intake.data.intake : null;

  const ready = due.kind !== "pending" && plan.kind !== "pending" && intake.kind !== "pending";
  const broken = due.kind === "failed" || plan.kind === "failed" || intake.kind === "failed";

  const present = [
    openIntake ? "intake" : "",
    dueTotal > 0 ? "due" : "",
    nextStep ? "plan" : "",
  ].filter(Boolean);
  const firstRun = ready && !broken && present.length === 0;
  const failedLead = CARDS.find((k) =>
    (k === "intake" ? intake : k === "due" ? due : plan).kind === "failed") ?? "";
  const lead: string = ready ? present[0] ?? (firstRun ? "plan" : failedLead) : "";
  const rank = (key: string): string | null => {
    const i = present.indexOf(key);
    return i === 0 ? "now" : i === 1 ? "next" : null;
  };
  const cardClass = (key: string) =>
    `panel stack home-card${lead === key ? " home-card--lead rail rail--accent" : ""}`;
  const ctaClass = (key: string) => (lead === key ? "btn btn--primary" : "btn");

  const rows: any[] = dueData?.items?.slice(0, ROWS) ?? [];
  const hidden = dueTotal - rows.length;

  const langDirty = lang !== serverLang;
  const langInert = !learnerId || !langDirty || save.kind === "saving";
  const langDescribed = ["lang-note", "lang-status", save.kind === "failed" ? "lang-error" : ""]
    .filter(Boolean)
    .join(" ");

  const intakeCard = (openIntake || intake.kind === "failed") && (
    <article key="intake" className={cardClass("intake")}>
      <CardHead title="Assessment unfinished" lead={lead === "intake"} rank={rank("intake")} />
      {intake.kind === "failed" ? (
        <Failed what="your unfinished assessment" at={intake} onRetry={() => void load(learnerId)} />
      ) : (
        <>
          <p>
            {openIntake.topic ?? "An assessment"} (
            {DEPTH_LABEL[openIntake.depth]?.label ?? openIntake.depth}) is part-way through.
            Your roadmap already exists; these questions decide what gets skipped.
          </p>
          <Link className={ctaClass("intake")} to="/learn">Pick it up</Link>
        </>
      )}
    </article>
  );

  const dueCard = (
    <article key="due" className={cardClass("due")}>
      <CardHead title="Due for review" lead={lead === "due"} rank={rank("due")} />
      {due.kind === "failed" ? (
        <Failed what="the review queue" at={due} onRetry={() => void load(learnerId)} />
      ) : dueTotal === 0 ? (
        <p className="muted">
          Nothing has faded and no wrong beliefs are on record. Confidence decays on a
          45-day half life, so this fills up on its own.
        </p>
      ) : (
        <>
          <p><b>{dueTotal}</b> concept{dueTotal === 1 ? "" : "s"} waiting.</p>
          <ul className="home-kinds">
            {KINDS.filter((k) => (dueData.byKind?.[k] ?? 0) > 0).map((k) => (
              <li key={k}>
                <b className="home-kind-n">{dueData.byKind[k]}</b>{" "}
                <span>{dueKindLabel(k, dueData.byKind[k])}</span>
              </li>
            ))}
          </ul>
          <Link className={ctaClass("due")} to="/review-session">Start review</Link>
        </>
      )}
    </article>
  );

  const planCard = (
    <article key="plan" className={cardClass("plan")}>
      <CardHead title="Next in the plan" lead={lead === "plan"} rank={rank("plan")} />
      {plan.kind === "failed" ? (
        <Failed what="your plan" at={plan} onRetry={() => void load(learnerId)} />
      ) : nextStep ? (
        <>
          <p><b>{nextStep.name}</b></p>
          <p className="row row--tight home-transition">
            <span className="mastery-mark" data-level={nextStep.currentMastery} aria-hidden="true" />
            <span className="mono">{nextStep.currentMastery}</span>
            <span className="home-arrow" aria-hidden="true">→</span>
            <span className="mastery-mark" data-level={nextStep.requiredLevel} aria-hidden="true" />
            <span className="mono">{nextStep.requiredLevel}</span>
            <span className="sr-only">
              from {nextStep.currentMastery} to {nextStep.requiredLevel}
            </span>
          </p>
          {planData.goal?.topic && (
            <p className="muted home-goal">
              {planData.goal.topic}
              {planData.goal.depth
                ? ` · ${DEPTH_LABEL[planData.goal.depth]?.label ?? planData.goal.depth}`
                : ""}
            </p>
          )}
          <Link className={ctaClass("plan")} to="/learn">Continue</Link>
        </>
      ) : planData ? (
        <>
          <p className="muted">
            Every step on the current plan is satisfied. Nothing is finished for good —
            confidence fades, so what you proved comes back to be re-proved.
          </p>
          <div className="row">
            <Link className={ctaClass("plan")} to="/learn">Set a new goal</Link>
            <Link className="btn" to={`/graph?learner=${encodeURIComponent(learnerId)}`}>
              Explore the graph
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            No plan yet. Name something you want to be able to do and the roadmap is built
            out of the graph, skipping whatever you can already demonstrate.
          </p>
          <Link className={ctaClass("plan")} to="/learn">Tell me what you want to learn</Link>
        </>
      )}
    </article>
  );

  const buildCard = (jobs.length > 0 || (jobsFailed && tracked.current.size > 0)) && (
    <article key="build" className="panel stack home-card">
      <CardHead title="Building" lead={false} rank={null} />
      {jobsFailed && jobs.length === 0 ? (
        <Failed what="the build queue" at={jobsFailed} onRetry={() => void syncJobs()} />
      ) : (
        <>
          <ul className="home-jobs">
            {jobs.map((j) => {
              const live = j.status === "queued" || j.status === "running";
              const pct = Math.round((j.progress ?? 0) * 100);
              return (
                <li key={j.id} className="stack stack--tight home-job">
                  <div className="row row--baseline">
                    <b>{j.topicName}</b>
                    <span className="mono muted home-job-state">
                      {j.status === "done"
                        ? "complete"
                        : j.status === "failed"
                          ? "stopped"
                          : j.status}
                    </span>
                  </div>
                  {live && (
                    <>
                      <div
                        className="progress"
                        role="progressbar"
                        aria-valuenow={pct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${j.topicName} build progress`}
                      >
                        <div className="bar" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="row row--baseline home-job-tick">
                        <Busy label={j.phase ?? "working"} clock={false} />
                        <span className="mono muted" aria-hidden="true">{pct}%</span>
                      </div>
                    </>
                  )}
                  {j.status === "done" && (
                    <p className="muted home-job-report">
                      {j.report?.conceptsCreated ?? 0} concepts written,{" "}
                      {j.report?.conceptsBound ?? 0} bound to what already existed,{" "}
                      {j.report?.edgesWritten ?? 0} links.
                    </p>
                  )}
                  {j.status === "failed" && (
                    <div className="notice notice--error" role="alert">
                      <strong>This build stopped.</strong>
                      <p className="home-fail-why">{j.error ?? "No reason was recorded."}</p>
                      <div className="row row--tight">
                        <button
                          className="linkish"
                          aria-disabled={!!retrying}
                          onClick={() => { if (!retrying) void retryJob(j.id); }}
                        >
                          start it again
                        </button>
                        {retrying === j.id && <Busy label="restarting" clock={false} />}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="muted home-job-note">
            Expansion samples the model three times per question and keeps only what a
            majority names, which is why it takes minutes. It survives a refresh.
          </p>
          <Link className="btn" to="/learn">Watch the build</Link>
        </>
      )}
    </article>
  );

  const byKey: Record<string, ReactNode> = {
    intake: intakeCard, due: dueCard, plan: planCard,
  };
  const order = [lead, ...CARDS.filter((k) => k !== lead)]
    .filter(Boolean)
    .map((k) => byKey[k]);

  return (
    <div className="page home page--wide">
      <div className="head home-top">
        <div>
          <h2>Where you left off</h2>
          {canShow && !ready ? (
            <Busy label="checking what is waiting" clock={false} />
          ) : (
            <p className="muted">Everything waiting on you, in one place.</p>
          )}
        </div>
        {hasRoster && (
          <label className="field">
            learner
            <select value={learnerId} onChange={(e) => setLearnerId(e.target.value)}>
              {learners.map((l) => <option key={l.id} value={l.id}>{l.email ?? l.name ?? l.id}</option>)}
            </select>
          </label>
        )}
      </div>

      {roster.kind === "pending" && (
        <div className="panel stack home-card home-solo" aria-busy="true">
          <span className="eyebrow">loading</span>
          <Placeholder />
        </div>
      )}

      {roster.kind === "failed" && (
        <div className="home-solo">
          <Failed what="the learner list" at={roster} onRetry={() => void loadRoster()} />
        </div>
      )}

      {noLearners && (
        <section className="panel stack home-solo">
          <h3 className="home-card-title">Nobody is set up here yet</h3>
          <p>
            Everything on this page is per learner: what you know, what has faded, what to
            teach next. Create one and the rest of the app has something to describe.
          </p>
          <form
            className="row"
            onSubmit={(e) => { e.preventDefault(); if (!creating) void createNew(); }}
          >
            <label className="field">
              email
              <input
                type="email"
                value={newEmail}
                onChange={(e) => { setNewEmail(e.target.value); setCreateError(""); }}
                placeholder="you@example.com"
                required
                {...(createError ? { "aria-describedby": "new-learner-error" } : {})}
              />
            </label>
            <button
              className="btn btn--primary"
              type="submit"
              aria-disabled={creating || !newEmail.trim()}
            >
              Create learner
            </button>
            {creating && <Busy label="creating" clock={false} />}
          </form>
          {createError && (
            <p className="notice notice--error" role="alert" id="new-learner-error">
              {createError}
            </p>
          )}
        </section>
      )}

      {canShow && (
        <>
          <div className="home-cards" aria-busy={!ready}>
            {ready ? (
              <>
                {order}
                {buildCard}
              </>
            ) : (
              <>
                <article className="panel stack home-card">
                  <CardHead title="Due for review" lead={false} rank={null} />
                  <Placeholder />
                </article>
                <article className="panel stack home-card">
                  <CardHead title="Next in the plan" lead={false} rank={null} />
                  <Placeholder />
                </article>
              </>
            )}
          </div>

          {ready && due.kind === "ok" && dueTotal > 0 && (
            <section className="home-list" aria-labelledby="due-list-head">
              <h3 className="eyebrow home-list-head" id="due-list-head">
                What is due, and why
              </h3>
              <ul className="home-due-rows">
                {rows.map((it: any) => (
                  <li key={it.conceptId} className="home-due">
                    {/* The belief stays outside the link: <Markdown> emits blocks and its own links */}
                    <Link
                      className="btn--bare home-due-open"
                      to={
                        `/graph?view=teach&focus=${encodeURIComponent(it.conceptId)}&hops=1` +
                        `&node=${encodeURIComponent(it.conceptId)}` +
                        `&learner=${encodeURIComponent(learnerId)}`
                      }
                      aria-label={
                        `${it.conceptName} — ${dueKindLabel(it.kind, 1)}. ` +
                        `${it.reason ?? ""} Opens this concept in the graph.`
                      }
                    >
                      <span className={`due-kind ${it.kind}`}>{dueKindLabel(it.kind, 1)}</span>
                      <span className="due-name">{it.conceptName}</span>
                      <span className="due-why">{it.reason}</span>
                    </Link>
                    {it.belief && (
                      <div className="home-due-belief">
                        <span className="eyebrow">recorded belief</span>
                        <div className="md"><Markdown text={it.belief} /></div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {hidden > 0 && (
                <p className="home-more">
                  <Link to="/review-session">+{hidden} more — start review</Link>
                </p>
              )}
            </section>
          )}

          {hasRoster && (
          <details className="panel home-lang">
            <summary className="home-lang-summary">
              <span className="eyebrow">you write code in</span>
              <span className="home-lang-value">{serverLang || "not set"}</span>
            </summary>
            <div className="stack home-lang-body">
              <div className="row">
                <label className="field">
                  language
                  <input
                    value={lang}
                    onChange={(e) => {
                      setLang(e.target.value);
                      if (save.kind !== "idle") setSave({ kind: "idle" });
                    }}
                    placeholder="e.g. JavaScript, Python, Rust"
                    list="lang-options"
                    aria-describedby={langDescribed}
                  />
                  <datalist id="lang-options">
                    {["JavaScript", "TypeScript", "Python", "Java", "Go", "Rust", "C", "C++", "SQL"]
                      .map((l) => <option key={l} value={l} />)}
                  </datalist>
                </label>
                {/* aria-disabled, not disabled: disabling the pressed control blurs focus */}
                <button
                  aria-disabled={langInert}
                  onClick={() => { if (!langInert) void saveLang(); }}
                >
                  save
                </button>
                {save.kind === "saving" && <Busy label="saving" clock={false} />}
              </div>
              <p className="muted home-lang-note" id="lang-note">
                {lang
                  ? "Every example and assessment is written in this."
                  : "Unset — questions may arrive in whichever language the concept is usually taught in."}
              </p>
              <p className="home-lang-status" id="lang-status" role="status">
                {save.kind === "ok"
                  ? "Saved. New questions and examples use it; existing ones are regenerated when they do not match."
                  : ""}
              </p>
              {save.kind === "failed" && (
                <p className="notice notice--error" role="alert" id="lang-error">
                  <strong>Not saved.</strong>
                  {save.remedy ?? save.message}
                </p>
              )}
            </div>
          </details>
          )}
        </>
      )}
    </div>
  );
}

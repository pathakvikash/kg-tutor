import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError } from "../api";
import { Busy } from "../components/Busy";
import { Markdown } from "../components/Markdown";
import { DEPTH_LABEL, DUE_KIND, dueKindLabel } from "../vocabulary";
import { resolveLearner, useStickyLearner } from "../useLearner";
import { getLearner } from "../learnerStore";

/** The queue's own ranking, highest cost of being ignored first. */
const KINDS = Object.keys(DUE_KIND) as (keyof typeof DUE_KIND)[];

/** How many rows the list draws before deferring to the review session itself. */
const ROWS = 8;

/**
 * The outcome of one read, not just its value.
 *
 * Every read on this page used to be `.catch(() => null)` and every null branch was
 * written as a positive assertion of emptiness, so a dead backend rendered "nothing has
 * faded and no wrong beliefs are on record" — the app telling you there is no work
 * because it could not find out. "Not asked yet", "asked, nothing there" and "asked, it
 * failed" are three different claims and each needs its own branch.
 */
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
  // 404 is the resource being genuinely absent — an empty state, not a fault.
  if (e instanceof HttpError && e.isMissing) return { kind: "absent" };
  return { kind: "failed", ...describe(e) };
}

/**
 * api.ts owns every other call. It has no create, and POST /api/learners was reachable
 * from nothing in the web app, which is why an empty roster was a dead end.
 */
async function createLearner(email: string): Promise<{ id: string }> {
  const res = await fetch("/api/learners", {
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

/**
 * The card's own heading, plus its rank.
 *
 * Priority used to be asserted three times and communicated none: the grid flattened DOM
 * order, both top cards got the same accent rail, and all three calls to action were
 * primary. The lead card is the only one that is wide, serif and primary, and "now" /
 * "next" states the order in words so it survives without colour or position.
 */
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

/**
 * Where a session starts.
 *
 * Every other page assumed you already knew what you wanted: the lesson page opens on
 * whatever the plan says, the graph opens on everything at once. Nothing ever said "two
 * concepts are due, one assessment is unfinished, and the next step is X" — so deciding
 * what to do meant checking three pages, and the review queue in particular was
 * invisible because nothing rendered it at all.
 */
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

  // A newer learner's reads must win, whichever order the two flights land in.
  const flight = useRef(0);

  const loadRoster = useCallback(async () => {
    setRoster(PENDING);
    const [r] = await Promise.allSettled([api.learners()]);
    const outcome = settle(r);
    setRoster(outcome);
    // Guarded, because an empty roster or a failed request used to leave the page
    // spinning behind a <select> with no options while two cards asserted there was
    // nothing to do.
    if (outcome.kind === "ok") setLearnerId(resolveLearner(getLearner(), outcome.data));
  }, [setLearnerId]);

  useEffect(() => { void loadRoster(); }, [loadRoster]);

  const load = useCallback(async (id: string) => {
    const mine = ++flight.current;
    // Cleared first: the previous learner's due rows used to sit under the new learner's
    // name, stamped with the new learner's id, so one click produced a URL that was
    // wrong in both halves.
    setDue(PENDING); setPlan(PENDING); setIntake(PENDING);
    if (!id) return;
    // Independent reads, so one slow or missing answer must not hide the rest — settled
    // rather than raced, so each card knows which of the three things happened to it.
    const [d, p, i] = await Promise.allSettled([api.due(id), api.plan(id), api.openIntake(id)]);
    if (flight.current !== mine) return;
    setDue(settle(d)); setPlan(settle(p)); setIntake(settle(i));
  }, []);

  useEffect(() => { void load(learnerId); }, [learnerId, load]);

  /**
   * Builds are global, not per learner, and they outlive their own success.
   *
   * The card was a frozen snapshot: it only refetched when the learner changed and it
   * filtered to queued/running, so a finished build never reported success and a failed
   * one vanished — including the server-restart explanation the API goes out of its way
   * to write.
   */
  const syncJobs = useCallback(async () => {
    const [r] = await Promise.allSettled([api.expansions()]);
    if (r.status !== "fulfilled") {
      setJobsFailed({ kind: "failed", ...describe(r.reason) });
      return;
    }
    for (const j of r.value) {
      if (j.status === "queued" || j.status === "running") tracked.current.add(j.id);
    }
    setJobs(r.value.filter((j: any) => tracked.current.has(j.id)));
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
    // Retry writes a fresh job, so its id has to be tracked or the new build is not the
    // one being watched.
    const [r] = await Promise.allSettled([api.retryExpansion(id)]);
    if (r.status === "fulfilled" && r.value?.id) tracked.current.add(r.value.id);
    if (r.status === "rejected") setJobsFailed({ kind: "failed", ...describe(r.reason) });
    await syncJobs();
    setRetrying("");
  }, [syncJobs]);

  const learners: any[] = roster.kind === "ok" ? roster.data : [];
  const noLearners = roster.kind === "absent" || (roster.kind === "ok" && learners.length === 0);
  const hasRoster = roster.kind === "ok" && learners.length > 0;
  // The roster failing must not blank the cards: a remembered learner is still enough
  // to ask the other three endpoints, and one dead endpoint hiding the rest is the
  // whole reason these reads are independent.
  const canShow = !!learnerId && !noLearners && roster.kind !== "pending";
  const serverLang: string = learners.find((l) => l.id === learnerId)?.workingLanguage ?? "";

  useEffect(() => {
    const record = learners.find((l) => l.id === learnerId);
    // Adopted once per learner. Keying this on `learners` meant the refetch after a
    // successful save unset the confirmation in the next commit, so it had never worked.
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
      // The route answers a bad address with a zod tree, which is not a sentence.
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

  // Ordered by what it costs to ignore: an unresolved wrong belief gets applied, an
  // unfinished assessment blocks a plan, a due review quietly rots. The auto-fit grid
  // used to flatten this, so the order was documented and then thrown away.
  const present = [
    openIntake ? "intake" : "",
    dueTotal > 0 ? "due" : "",
    nextStep ? "plan" : "",
  ].filter(Boolean);
  const firstRun = ready && !broken && present.length === 0;
  const lead = ready ? present[0] ?? (firstRun ? "plan" : "") : "";
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
          {/* One line per kind rather than a joined sentence: two of the three shared
              labels are clauses, so the join read "1 confidence has faded". */}
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
        <p className="muted">
          Every step on the current plan is satisfied. Set a new goal, or explore the
          graph and assess yourself on anything.
        </p>
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

  const buildCard = (jobs.length > 0 || jobsFailed) && (
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
                          : j.phase ?? j.status}
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
                      <Busy label={`${pct}% — ${j.phase ?? "working"}`} clock={false} />
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

  // A first run has exactly one thing to do, so the card that offers it leads.
  const order = firstRun ? [planCard, dueCard, intakeCard] : [intakeCard, dueCard, planCard];

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
              {learners.map((l) => <option key={l.id} value={l.id}>{l.email}</option>)}
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
              /* Skeletons, not an empty state: nothing has been asked yet, and the two
                 cards that always exist are the ones drawn so the layout holds still. */
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
                    {/* A real link, and the belief lives outside it: <Markdown> emits
                        blocks and target="_blank" links, and inside a <button> a belief
                        containing a URL was a keyboard trap that both opened a tab and
                        fired the row's own navigation. */}
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

          {/* Below the cards, and collapsed. It steers every generated example, which is
              why it is on this page rather than in settings — many concepts are
              language-neutral ("memory addresses" under "Data Structures" implies
              nothing), so without it the item generator picks, and it picked C for a
              learner working through JavaScript. But it is configuration, and three
              sentences of it were the first thing on the page.
              Needs the roster: the field's current value comes from the learner record,
              so with no roster there is nothing to show as saved or unsaved. */}
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
                {/* aria-disabled, not disabled: disabling the control the user just
                    pressed blurs focus to <body>. */}
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

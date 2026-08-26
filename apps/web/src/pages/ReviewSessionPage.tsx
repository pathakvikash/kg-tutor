import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Markdown } from "../components/Markdown";
import { resolveLearner, useStickyLearner } from "../useLearner";

/**
 * One pass over what has gone stale.
 *
 * Distinct from a lesson: nothing here is taught. Each item is a concept the learner
 * held once — or holds a recorded wrong belief about — and the only question is whether
 * it still stands up. A pass restores confidence and clears the belief; a failure records
 * that honestly and the concept comes back.
 */
export function ReviewSessionPage() {
  const [learners, setLearners] = useState<any[]>([]);
  const [learnerId, setLearnerId] = useStickyLearner();
  const [queue, setQueue] = useState<any[]>([]);
  const [at, setAt] = useState(0);
  const [question, setQuestion] = useState<any>(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ passed: number; failed: number }>({ passed: 0, failed: 0 });

  useEffect(() => {
    void api.learners().then((l) => { setLearners(l); setLearnerId(resolveLearner(learnerId, l)); });
  }, []);

  const loadQueue = useCallback(async (id: string) => {
    if (!id) return;
    setBusy("finding what is due");
    try {
      const d = await api.due(id, 10);
      setQueue(d.items ?? []);
      setAt(0); setQuestion(null); setResult(null);
      setDone({ passed: 0, failed: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }, []);

  useEffect(() => { void loadQueue(learnerId); }, [learnerId, loadQueue]);

  const current = queue[at] ?? null;

  const ask = async () => {
    if (!current) return;
    setBusy("writing a question"); setError(null); setResult(null);
    try {
      // The level it was held at, not the next one up: this is a re-check, not a promotion.
      setQuestion(await api.check(learnerId, current.conceptId, current.mastery === "unknown" ? "familiar" : current.mastery));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  const submit = async () => {
    if (!answer.trim() || !question || !current) return;
    setBusy("checking"); setError(null);
    try {
      const r = await api.attempt(learnerId, {
        conceptId: current.conceptId,
        prompt: question.prompt,
        response: answer,
        requiresTransfer: question.requiresTransfer,
        itemId: question.itemId,
      });
      setResult(r);
      setQuestion(null);
      setAnswer("");
      setDone((d) => ({
        passed: d.passed + (r.grade.correct ? 1 : 0),
        failed: d.failed + (r.grade.correct ? 0 : 1),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  const next = () => { setResult(null); setQuestion(null); setAnswer(""); setAt((i) => i + 1); };

  if (!current && queue.length > 0) {
    return (
      <div className="page">
        <h2>Review done</h2>
        <p>
          {done.passed} held up, {done.failed} did not. Anything that failed is back in the
          queue with its confidence recorded honestly rather than assumed.
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="primary" onClick={() => void loadQueue(learnerId)}>Check again</button>
          <Link className="btn" to="/">Home</Link>
        </div>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="page">
        <h2>Nothing due</h2>
        <p className="muted">
          Nothing has decayed past the re-probe floor and no wrong beliefs are on record.
        </p>
        <Link className="btn" to="/">Home</Link>
      </div>
    );
  }

  return (
    <div className="page review-session">
      <div className="home-head">
        <div>
          <h2>Review</h2>
          <p className="muted">
            {at + 1} of {queue.length} · nothing here is taught, only checked
          </p>
        </div>
        <label className="field">
          learner
          <select value={learnerId} onChange={(e) => setLearnerId(e.target.value)}>
            {learners.map((l) => <option key={l.id} value={l.id}>{l.email}</option>)}
          </select>
        </label>
      </div>

      <div className="progress"><div className="bar" style={{ width: `${(at / queue.length) * 100}%` }} /></div>

      <article className="card" style={{ marginTop: 16 }}>
        <div className="chips">
          <span className={`due-kind ${current.kind}`}>{current.kind}</span>
          <span className="chip">held at {current.mastery}</span>
          <span className="chip">confidence {current.confidence.toFixed(2)}</span>
        </div>
        <h3 style={{ marginTop: 10 }}>{current.conceptName}</h3>
        <p className="muted">{current.reason}</p>
        {current.belief && (
          <div className="prereq-warn" style={{ marginTop: 10 }}>
            <strong>What you appeared to believe</strong>
            <p style={{ marginBottom: 0 }}>{current.belief}</p>
          </div>
        )}

        {!question && !result && (
          <button className="primary" style={{ marginTop: 12 }} onClick={() => void ask()} disabled={busy !== null}>
            {busy ?? "Check this one"}
          </button>
        )}

        {question && (
          <div style={{ marginTop: 12 }}>
            <div className="coach-q">
              <Markdown text={question.prompt} />
              {question.code && (
                <Markdown text={`\`\`\`${question.codeLanguage ?? ""}\n${question.code}\n\`\`\``} />
              )}
            </div>
            <textarea
              rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)}
              placeholder="In your own words." disabled={busy !== null}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="primary" onClick={() => void submit()} disabled={busy !== null || !answer.trim()}>
                {busy ?? "Answer"}
              </button>
              <button onClick={next} disabled={busy !== null}>Skip</button>
            </div>
          </div>
        )}

        {result && (
          <div className={result.grade.correct ? "verdict ok" : "verdict gap"} style={{ marginTop: 12 }}>
            <strong>{result.grade.correct ? "Still holds." : "Not any more."}</strong>{" "}
            <span className="verdict-why"><Markdown text={result.grade.reasoning} /></span>
            <div className="chips" style={{ marginTop: 8 }}>
              <span className="chip">
                {result.state.before.mastery} → <b>{result.state.after.mastery}</b>
              </span>
              <span className="chip">confidence {result.state.after.confidence.toFixed(2)}</span>
              {result.misconceptionsResolved > 0 && (
                <span className="chip">
                  cleared {result.misconceptionsResolved} recorded belief
                  {result.misconceptionsResolved === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <button className="primary" style={{ marginTop: 10 }} onClick={next}>
              {at + 1 < queue.length ? "Next" : "Finish"}
            </button>
          </div>
        )}
        {error && <p className="err">{error}</p>}
      </article>
    </div>
  );
}

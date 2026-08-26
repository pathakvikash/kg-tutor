import { useEffect, useRef, useState } from "react";
import { api, askStream, type Mastery } from "../api";
import { Markdown } from "./Markdown";

const RANK: Record<Mastery, number> = { unknown: 0, familiar: 1, functional: 2, solid: 3 };

/**
 * Assessment and chat for whichever concept is selected in the graph.
 *
 * The graph could already show what a learner knows and could not do anything about it —
 * a node reading "unknown" was a dead end, and changing it meant leaving for the lesson
 * page and hoping the planner offered that concept next. Which it usually would not: the
 * planner follows the plan, and the concept you are curious about is rarely the next step.
 *
 * So the graph gets the two things that move a node: a check that can raise its mastery,
 * and somewhere to ask about it without that counting as being taught. (19)
 */
export function NodeCoach({
  learnerId, conceptId, conceptName, mastery, requiredLevel = "functional", onStateChanged,
}: {
  learnerId: string;
  conceptId: string;
  conceptName: string;
  mastery: Mastery;
  requiredLevel?: Mastery;
  /** The node's colour is derived from mastery, so the graph has to be told. */
  onStateChanged: () => void;
}) {
  const [tab, setTab] = useState<"assess" | "ask">("assess");
  const [question, setQuestion] = useState<any>(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<{ role: "learner" | "tutor"; text: string }[]>([]);
  const [input, setInput] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  // Selecting a different node has to clear the previous one's question and verdict,
  // or an answer gets graded against a concept the learner is no longer looking at.
  useEffect(() => {
    setQuestion(null); setAnswer(""); setResult(null);
    setError(null); setTurns([]); setInput("");
  }, [conceptId]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [turns, busy]);

  /** The level worth testing: one above where they are, capped at what the plan needs. */
  const target: Mastery =
    RANK[mastery] >= RANK[requiredLevel]
      ? requiredLevel
      : (["familiar", "functional", "solid"] as const)[
          Math.min(RANK[mastery], 2)
        ] ?? "functional";

  const startCheck = async () => {
    setBusy("writing a question"); setError(null); setResult(null);
    try {
      setQuestion(await api.check(learnerId, conceptId, target));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  const submit = async () => {
    if (!answer.trim() || !question) return;
    setBusy("grading"); setError(null);
    try {
      const r = await api.attempt(learnerId, {
        conceptId,
        prompt: question.prompt,
        response: answer,
        requiresTransfer: question.requiresTransfer,
        itemId: question.itemId,
      });
      setResult(r);
      setQuestion(null);
      setAnswer("");
      // Mastery may have moved, and so may a prerequisite's — the server credits those.
      onStateChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  const ask = async () => {
    const text = input.trim();
    if (!text) return;
    setInput(""); setError(null);
    setTurns((prev) => [...prev, { role: "learner", text }]);
    setBusy("thinking");
    let index = -1;
    await askStream(learnerId, conceptId, text, {
      onOpen: () => {
        setBusy(null);
        setTurns((prev) => { index = prev.length; return [...prev, { role: "tutor", text: "" }]; });
      },
      onDelta: (chunk) => {
        setTurns((prev) => {
          if (index < 0 || !prev[index]) return prev;
          const next = [...prev];
          next[index] = { ...next[index]!, text: next[index]!.text + chunk };
          return next;
        });
      },
      onFailed: (message) => { setError(message); setBusy(null); },
    });
    setBusy(null);
  };

  return (
    <section className="coach">
      <div className="coach-tabs">
        <button className={tab === "assess" ? "on" : ""} onClick={() => setTab("assess")}>
          Assess
        </button>
        <button className={tab === "ask" ? "on" : ""} onClick={() => setTab("ask")}>
          Ask
        </button>
      </div>

      {tab === "assess" ? (
        <div className="coach-body">
          {!question && !result && (
            <>
              <p className="muted" style={{ fontSize: 12.5 }}>
                {mastery === "unknown"
                  ? `Nothing recorded for ${conceptName} yet. One question decides where it starts.`
                  : `Currently ${mastery}. A correct answer at ${target} moves it; a wrong one records what went wrong.`}
              </p>
              <button className="primary" onClick={() => void startCheck()} disabled={busy !== null}>
                {busy ?? `Test me on ${conceptName}`}
              </button>
            </>
          )}

          {question && (
            <>
              <div className="coach-q">
                <Markdown text={question.prompt} />
                {question.code && (
                  <Markdown
                    text={`\`\`\`${question.codeLanguage ?? ""}\n${question.code}\n\`\`\``}
                  />
                )}
              </div>
              {question.requiresTransfer && (
                <p className="muted" style={{ fontSize: 12 }}>
                  Deliberately an unfamiliar setting — recalling the explanation will not
                  be enough here.
                </p>
              )}
              <textarea
                rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)}
                placeholder="In your own words."
                disabled={busy !== null}
              />
              <div style={{ display: "flex", gap: 6 }}>
                <button className="primary" onClick={() => void submit()} disabled={busy !== null || !answer.trim()}>
                  {busy ?? "Answer"}
                </button>
                <button onClick={() => { setQuestion(null); setAnswer(""); }} disabled={busy !== null}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {result && (
            <div className={result.grade.correct ? "verdict ok" : "verdict gap"}>
              <strong>{result.grade.correct ? "Correct." : "Not quite."}</strong>{" "}
              <span className="verdict-why"><Markdown text={result.grade.reasoning} /></span>
              <div className="chips" style={{ marginTop: 8 }}>
                <span className="chip">
                  {result.state.before.mastery} → <b>{result.state.after.mastery}</b>
                </span>
                <span className="chip">
                  confidence {result.state.after.confidence.toFixed(2)}
                </span>
                <span className="chip">{String(result.evidenceKind).replace(/_/g, " ")}</span>
                {result.propagatedTo?.length > 0 && (
                  <span className="chip">credited {result.propagatedTo.length} prerequisite(s)</span>
                )}
              </div>
              <button style={{ marginTop: 10 }} onClick={() => void startCheck()} disabled={busy !== null}>
                {busy ?? "Ask me another"}
              </button>
            </div>
          )}
          {error && <p className="err">{error}</p>}
        </div>
      ) : (
        <div className="coach-body">
          <p className="muted" style={{ fontSize: 12.5 }}>
            Questions about {conceptName}. Asking is not being taught — nothing here
            changes what you know on record.
          </p>
          <div className="coach-chat">
            {turns.length === 0 && (
              <p className="muted" style={{ fontSize: 12.5 }}>
                e.g. "why does this need {conceptName}?", "show me the smallest example".
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`bubble ${t.role}`}>
                {t.role === "tutor" ? <Markdown text={t.text} /> : t.text}
              </div>
            ))}
            {busy && <p className="muted" style={{ fontSize: 12 }}>{busy}…</p>}
            <div ref={bottom} />
          </div>
          <textarea
            rows={2} value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); }
            }}
            placeholder={`Ask about ${conceptName}…`}
          />
          <button className="primary" onClick={() => void ask()} disabled={!input.trim()}>
            Ask
          </button>
          {error && <p className="err">{error}</p>}
        </div>
      )}
    </section>
  );
}

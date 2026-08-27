import { useEffect, useId, useRef, useState } from "react";
import { api, askStream, type Mastery } from "../api";
import { Markdown } from "./Markdown";
import { Busy } from "./Busy";
import { MASTERY_RANK as RANK, atLeast } from "../vocabulary";

type Tab = "assess" | "ask";
const TABS: Tab[] = ["assess", "ask"];

/** Assessment and chat for the concept selected in the graph. (19) */
export function NodeCoach({
  learnerId, conceptId, conceptName, mastery, requiredLevel = "functional",
  unmetPrerequisites = [], onStateChanged, onPick,
}: {
  learnerId: string;
  conceptId: string;
  conceptName: string;
  mastery: Mastery;
  requiredLevel?: Mastery;
  /** Hard prerequisites not reached yet; assessing over one blames the wrong concept. */
  unmetPrerequisites?: { id: string; name: string; mastery: Mastery }[];
  /** The node's colour is derived from mastery, so the graph has to be told. */
  onStateChanged: () => void;
  /** Jump to a prerequisite instead. */
  onPick?: (conceptId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("assess");
  const [question, setQuestion] = useState<any>(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<{ role: "learner" | "tutor"; text: string }[]>([]);
  const [input, setInput] = useState("");
  const chat = useRef<HTMLDivElement>(null);
  /** Guards the stream itself: two Enters used to open two streams into one turns array. */
  const inFlight = useRef(false);
  const ids = useId();

  // Cleared on a selection change, or an answer is graded against the wrong concept.
  useEffect(() => {
    setQuestion(null); setAnswer(""); setResult(null);
    setError(null); setTurns([]); setInput("");
    setBusy(null); setStreaming(false);
    inFlight.current = false;
  }, [conceptId]);

  useEffect(() => {
    // Scroll the chat box itself; scrollIntoView moves the whole inspector.
    const el = chat.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  /** Already at or past what the plan needs — so nothing here can raise it. */
  const atCeiling = atLeast(mastery, requiredLevel);
  /** The level worth testing: one above where they are, capped at what the plan needs. */
  const target: Mastery = atCeiling
    ? requiredLevel
    : (["familiar", "functional", "solid"] as const)[Math.min(RANK[mastery], 2)] ?? "functional";

  const startCheck = async () => {
    if (busy) return;
    setBusy("writing a question"); setError(null); setResult(null);
    try {
      setQuestion(await api.check(learnerId, conceptId, target));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  const submit = async () => {
    if (!answer.trim() || !question || busy) return;
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
    if (!text || inFlight.current) return;
    inFlight.current = true;
    setInput(""); setError(null);
    setTurns((prev) => [...prev, { role: "learner", text }]);
    setBusy("thinking");
    let index = -1;
    try {
      await askStream(learnerId, conceptId, text, {
        onOpen: () => {
          setBusy(null);
          setStreaming(true);
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
        onFailed: (message) => { setError(message); },
      });
    } catch (e) {
      // A dropped connection rejects instead of reporting `failed`.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(null);
      setStreaming(false);
    }
  };

  /** Roving tabindex, so the pair is one tab stop and the arrows move between them. */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]!;
    setTab(next);
    // getElementById, not querySelector: useId values contain colons.
    document.getElementById(`${ids}-tab-${next}`)?.focus();
  };

  return (
    <section className="coach">
      <div
        className="coach-tabs"
        role="tablist"
        aria-label="assess or ask"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((t) => (
          <button
            key={t}
            id={`${ids}-tab-${t}`}
            role="tab"
            aria-selected={tab === t}
            aria-controls={`${ids}-panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            className={tab === t ? "on" : ""}
            onClick={() => setTab(t)}
          >
            {t === "assess" ? "Assess" : "Ask"}
          </button>
        ))}
      </div>

      {tab === "assess" ? (
        <div
          className="coach-body"
          role="tabpanel"
          id={`${ids}-panel-assess`}
          aria-labelledby={`${ids}-tab-assess`}
        >
          {!question && !result && unmetPrerequisites.length > 0 && (
            <div className="prereq-warn">
              <strong>{unmetPrerequisites.length === 1 ? "One thing" : `${unmetPrerequisites.length} things`} this builds on {unmetPrerequisites.length === 1 ? "is" : "are"} not solid yet.</strong>
              <p>
                Items for {conceptName} are written so they cannot be answered without
                {unmetPrerequisites.length === 1 ? " it" : " these"} — so a wrong answer here
                would get recorded against {conceptName} when the gap is elsewhere.
              </p>
              <div className="chips">
                {unmetPrerequisites.map((p) => (
                  <button
                    key={p.id}
                    className="chip chip--action"
                    onClick={() => onPick?.(p.id)}
                    title={`Go to ${p.name} instead`}
                  >
                    {p.name} <em>{p.mastery}</em>
                  </button>
                ))}
              </div>
            </div>
          )}
          {!question && !result && (
            <>
              <p className="muted coach-note">
                {mastery === "unknown"
                  ? `Nothing recorded for ${conceptName} yet. One question decides where it starts.`
                  : atCeiling
                    ? `Already ${mastery} — at or past the ${requiredLevel} the plan asks for. A correct answer will not raise it, so the only thing this can change is a record of a step back.`
                    : `Currently ${mastery}. A correct answer at ${target} moves it; a wrong one records what went wrong.`}
              </p>
              <div className="row">
                <button
                  className={unmetPrerequisites.length > 0 || atCeiling ? "" : "primary"}
                  onClick={() => void startCheck()}
                  aria-disabled={busy !== null}
                >
                  {unmetPrerequisites.length > 0
                    ? "Test me anyway"
                    : atCeiling
                      ? `Re-check ${conceptName}`
                      : `Test me on ${conceptName}`}
                </button>
                {busy && <Busy label={busy} />}
              </div>
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
                <p className="muted coach-note">
                  Deliberately an unfamiliar setting — recalling the explanation will not
                  be enough here.
                </p>
              )}
              <textarea
                rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)}
                placeholder="In your own words."
                aria-label={`Your answer about ${conceptName}`}
                // readOnly, not disabled: disabling a focused control blurs it to <body>.
                readOnly={busy !== null}
                aria-disabled={busy !== null}
              />
              <div className="row">
                <button
                  className="primary"
                  onClick={() => void submit()}
                  aria-disabled={busy !== null || !answer.trim()}
                >
                  Answer
                </button>
                <button
                  onClick={() => { setQuestion(null); setAnswer(""); }}
                  aria-disabled={busy !== null}
                >
                  Cancel
                </button>
                {busy && <Busy label={busy} />}
              </div>
            </>
          )}

          {result && (
            <div className={result.grade.correct ? "verdict ok" : "verdict gap"}>
              <strong>{result.grade.correct ? "Correct." : "Not quite."}</strong>{" "}
              <span className="verdict-why"><Markdown text={result.grade.reasoning} /></span>
              <div className="chips">
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
              <div className="row verdict-again">
                <button onClick={() => void startCheck()} aria-disabled={busy !== null}>
                  Ask me another
                </button>
                {busy && <Busy label={busy} />}
              </div>
            </div>
          )}
          {error && <p className="notice notice--error" role="alert">{error}</p>}
        </div>
      ) : (
        <div
          className="coach-body"
          role="tabpanel"
          id={`${ids}-panel-ask`}
          aria-labelledby={`${ids}-tab-ask`}
        >
          <p className="muted coach-note">
            Questions about {conceptName}. Asking is not being taught — nothing here
            changes what you know on record.
          </p>
          <div className="coach-chat" ref={chat}>
            {turns.length === 0 && (
              <p className="muted coach-note">
                e.g. "why does this need {conceptName}?", "show me the smallest example".
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`bubble ${t.role}`}>
                {t.role === "tutor" ? <Markdown text={t.text} /> : t.text}
                {/* The caret marks a stream still in flight, not a finished answer. */}
                {t.role === "tutor" && streaming && i === turns.length - 1 && (
                  <span className="caret" />
                )}
              </div>
            ))}
          </div>
          <textarea
            rows={2} value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); }
            }}
            placeholder={`Ask about ${conceptName}…`}
            aria-label={`Ask about ${conceptName}`}
          />
          <div className="row">
            <button
              className="primary"
              onClick={() => void ask()}
              aria-disabled={!input.trim() || busy !== null || streaming}
            >
              Ask
            </button>
            {busy && <Busy label={busy} />}
          </div>
          {error && <p className="notice notice--error" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}

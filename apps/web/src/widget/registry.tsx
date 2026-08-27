import { useRef, useState } from "react";
import { defineRegistry, useStateBinding } from "@json-render/react";
import { catalog } from "./catalog";

interface Step {
  label?: string;
  detail?: string;
  code?: string;
  highlightLine?: number;
  frames?: Record<string, string[]>;
}

/**
 * The boxes in a region are a picture of a list; this is the same fact as a sentence,
 * which is what a live region can actually announce.
 */
function regionSummary(name: string, items: string[]): string {
  if (items.length === 0) return `${name}: empty`;
  return `${name}: ${items.length} ${items.length === 1 ? "frame" : "frames"}, ${items.join(", ")}`;
}

function Code({ code, language, highlight }: { code: string; language?: string; highlight?: number }) {
  const lines = String(code ?? "").split("\n");
  return (
    <pre className="code-block w-code" data-lang={language || undefined}>
      <code>
        {lines.map((l, i) => (
          <span key={i} className={highlight === i + 1 ? "line hl" : "line"}>
            {l || " "}
          </span>
        ))}
      </code>
    </pre>
  );
}

export const { registry } = defineRegistry(catalog, {
  components: {
    Stack: ({ props, children }: any) => (
      <div className="w-stack" style={{ gap: props.gap ?? 12 }}>{children}</div>
    ),

    // A real heading, not a styled div: model-authored headings were the only structure
    // on the longest surface in the app and heading navigation returned nothing.
    Heading: ({ props }: any) => <h4 className="w-heading">{props.value}</h4>,

    Text: ({ props }: any) => (
      <p className={props.muted ? "w-text muted" : "w-text"}>{props.value}</p>
    ),

    CodeBlock: ({ props }: any) => (
      <Code code={props.code} language={props.language} highlight={props.highlightLine} />
    ),

    /**
     * The learner drives the clock. Auto-playing an animation shows the same thing but
     * teaches less — stepping forces a prediction before each reveal, which is the
     * whole point of a worked example.
     */
    Timeline: ({ props }: any) => {
      const key = props.stateKey ?? "step";
      // useStateBinding is the documented read/write pair. Reading the raw store object
      // by key looked equivalent and silently never re-rendered.
      const [raw, setRaw] = useStateBinding<number>(`/${key}`);
      const steps: Step[] = props.steps ?? [];
      const i = Math.min(Math.max(Number(raw ?? 0), 0), Math.max(0, steps.length - 1));
      const step = steps[i] ?? {};
      const go = (n: number) => setRaw(Math.min(Math.max(n, 0), steps.length - 1));

      if (steps.length === 0) return null;
      return (
        <div className="w-timeline">
          <div className="w-tl-head">
            {/* aria-disabled, never disabled: the last press of Next is what reaches the
                final step, and disabling it there blurs focus to <body>. go() clamps. */}
            <button onClick={() => go(i - 1)} aria-disabled={i === 0 || undefined} aria-label="Previous step">←</button>
            <div className="w-tl-dots" role="group" aria-label="Steps">
              {steps.map((_, n) => (
                <button
                  key={n}
                  className={n === i ? "dot on" : n < i ? "dot done" : "dot"}
                  onClick={() => go(n)}
                  aria-current={n === i ? "step" : undefined}
                  aria-label={`Step ${n + 1}`}
                />
              ))}
            </div>
            <button onClick={() => go(i + 1)} aria-disabled={i === steps.length - 1 || undefined} aria-label="Next step">→</button>
            <span className="w-tl-count">{i + 1} / {steps.length}</span>
          </div>
          {/* Next replaces label, code and detail in place, so without a live region the
              one thing this widget exists to do is silent. */}
          <div aria-live="polite" aria-atomic="true">
            <span className="sr-only">Step {i + 1} of {steps.length}.</span>
            {step.label && <div className="w-tl-label">{step.label}</div>}
            {step.code && <Code code={step.code} highlight={step.highlightLine} />}
            {step.detail && <p className="w-text">{step.detail}</p>}
          </div>
        </div>
      );
    },

    Frames: ({ props }: any) => {
      const items: string[] = Array.isArray(props.items) ? props.items : [];
      const stack = props.orientation !== "queue";
      // A call stack that grows downward on screen contradicts every diagram a learner
      // has ever seen, so the newest frame renders at the top.
      const ordered = stack ? [...items].reverse() : items;
      return (
        <div className={`w-frames ${stack ? "as-stack" : "as-queue"}`}>
          {props.title && <div className="w-frames-title">{props.title}</div>}
          {ordered.length === 0 ? (
            <div className="w-frame empty">{props.empty ?? "empty"}</div>
          ) : (
            <div className="w-frame-list">
              {ordered.map((it, n) => (
                <div className={`w-frame${stack && n === 0 ? " top" : ""}`} key={`${it}-${n}`}>
                  {it}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    },

    /**
     * The architecture view: several regions moving together under one clock.
     *
     * Frames could already draw a single stack or queue, but nothing could show a call
     * stack draining while a microtask queue fills — which IS the event loop, and is
     * the thing prose is worst at. Regions are laid out side by side and every step
     * declares the full contents of all of them, so nothing has to be inferred from a
     * diff the learner cannot see.
     */
    Simulation: ({ props }: any) => {
      const key = props.stateKey ?? "tick";
      const [raw, setRaw] = useStateBinding<number>(`/${key}`);
      const steps: any[] = props.steps ?? [];
      const regions: string[] = props.regions ?? [];
      const stackish = new Set<string>(props.stackRegions ?? []);
      const i = Math.min(Math.max(Number(raw ?? 0), 0), Math.max(0, steps.length - 1));
      const step = steps[i] ?? {};
      const go = (n: number) => setRaw(Math.min(Math.max(n, 0), steps.length - 1));

      if (steps.length === 0 || regions.length === 0) return null;

      const previous: Record<string, string[]> = steps[i - 1]?.regions ?? {};
      // The code block itself is fixed across ticks; only the highlighted line moves, so
      // that line is announced as text instead of re-reading the whole listing.
      const activeLine = step.highlightLine && props.code
        ? String(props.code).split("\n")[Number(step.highlightLine) - 1]?.trim()
        : undefined;

      return (
        <div className="w-sim">
          <div className="w-tl-head">
            {/* aria-disabled, never disabled: the press that reaches the last tick would
                otherwise disable itself and blur focus to <body>. go() clamps. */}
            <button onClick={() => go(0)} aria-disabled={i === 0 || undefined} aria-label="Restart">⏮</button>
            <button onClick={() => go(i - 1)} aria-disabled={i === 0 || undefined} aria-label="Back">←</button>
            <div className="w-tl-dots" role="group" aria-label="Ticks">
              {steps.map((_, n) => (
                <button
                  key={n}
                  className={n === i ? "dot on" : n < i ? "dot done" : "dot"}
                  onClick={() => go(n)}
                  aria-current={n === i ? "step" : undefined}
                  aria-label={`Tick ${n + 1}`}
                />
              ))}
            </div>
            <button onClick={() => go(i + 1)} aria-disabled={i === steps.length - 1 || undefined} aria-label="Forward">→</button>
            <span className="w-tl-count">{i + 1} / {steps.length}</span>
          </div>

          {props.code && (
            <Code code={props.code} language={props.language} highlight={step.highlightLine} />
          )}

          {/* One live region over every region and the caption: a tick replaces all of
              them at once, and separate regions would interleave mid-sentence. */}
          <div aria-live="polite" aria-atomic="true">
            <span className="sr-only">
              Tick {i + 1} of {steps.length}.
              {activeLine ? ` Line ${step.highlightLine}: ${activeLine}.` : ""}
            </span>
            <div className="w-regions">
              {regions.map((name) => {
                const items: string[] = step.regions?.[name] ?? [];
                const before: string[] = previous[name] ?? [];
                const isStack = stackish.has(name);
                const shown = isStack ? [...items].reverse() : items;
                return (
                  <div className="w-region" key={name}>
                    {/* The boxes below say the same thing visually, so they are hidden
                        rather than announced a second time item by item. */}
                    <span className="sr-only">{regionSummary(name, shown)}</span>
                    <div className="w-region-title" aria-hidden="true">{name}</div>
                    {shown.length === 0 ? (
                      <div className="w-frame empty" aria-hidden="true">empty</div>
                    ) : (
                      <div className="w-frame-list" aria-hidden="true">
                        {shown.map((it, n) => (
                          <div
                            key={`${it}-${n}`}
                            /* New since the last tick, so movement between regions is
                               visible rather than something to spot by comparing. */
                            className={`w-frame${!before.includes(it) ? " fresh" : ""}${isStack && n === 0 ? " top" : ""}`}
                          >
                            {it}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {step.label && <div className="w-tl-label">{step.label}</div>}
            {step.detail && <p className="w-text">{step.detail}</p>}
          </div>
        </div>
      );
    },

    Compare: ({ props }: any) => (
      <div className="w-compare-wrap">
        <div className="w-compare">
          <div>
            {/* h5: these label the two halves of one comparison, which sits under a
                Heading (h4) in every spec the model writes. */}
            <h5 className="w-heading">{props.leftTitle}</h5>
            <Code code={props.leftCode} />
          </div>
          <div>
            <h5 className="w-heading">{props.rightTitle}</h5>
            <Code code={props.rightCode} />
          </div>
        </div>
        {props.note && <p className="w-text muted">{props.note}</p>}
      </div>
    ),

    /** Feedback is per option: being told *why* your specific wrong answer is wrong is
     *  the part that teaches, and a bare right/wrong throws it away. */
    Choice: ({ props }: any) => {
      const [picked, setPicked] = useState<number | null>(null);
      const optionsRef = useRef<HTMLDivElement>(null);
      const options: { label: string; correct?: boolean; feedback?: string }[] = props.options ?? [];
      const answered = picked !== null;
      const chosen = picked === null ? null : options[picked] ?? null;
      const retry = () => {
        setPicked(null);
        // "try again" unmounts itself on click, which would drop focus to <body>.
        requestAnimationFrame(() =>
          optionsRef.current?.querySelector<HTMLButtonElement>(".w-opt")?.focus(),
        );
      };
      return (
        <div className="w-choice">
          <h4 className="w-heading">{props.question}</h4>
          <div className="w-options" ref={optionsRef}>
            {options.map((o, i) => {
              const state = !answered ? "" : picked === i ? (o.correct ? "right" : "wrong") : "dim";
              return (
                <button
                  key={i}
                  className={state ? `w-opt ${state}` : "w-opt"}
                  // aria-disabled, not disabled: the outcome is attached to the button the
                  // learner just pressed, and disabling it blurs focus off the answer.
                  aria-disabled={answered || undefined}
                  onClick={() => { if (!answered) setPicked(i); }}
                >
                  {(state === "right" || state === "wrong") && (
                    <span className="w-opt-mark" aria-hidden="true">{state === "right" ? "✓" : "✗"}</span>
                  )}
                  <span className="w-opt-label">{o.label}</span>
                  {/* Border and text colour do not survive greyscale, and the glyph above
                      is decorative. */}
                  {state === "right" && <span className="sr-only"> — correct</span>}
                  {state === "wrong" && <span className="sr-only"> — incorrect</span>}
                </button>
              );
            })}
          </div>
          {/* Present before the answer, so the verdict is announced rather than appearing
              somewhere below the focused option. */}
          <div aria-live="polite">
            {answered && (
              <p className={chosen?.correct ? "w-feedback right" : "w-feedback wrong"}>
                {chosen?.feedback ?? (chosen?.correct ? "Correct." : "Not quite.")}
              </p>
            )}
          </div>
          {answered && !chosen?.correct && (
            <button className="linkish" onClick={retry}>try again</button>
          )}
        </div>
      );
    },

    Toggle: ({ props }: any) => {
      const key = props.stateKey ?? "toggled";
      const [raw, setRaw] = useStateBinding<boolean>(`/${key}`);
      const on = Boolean(raw);
      return (
        <button className={on ? "w-toggle on" : "w-toggle"} onClick={() => setRaw(!on)}>
          <span className="w-toggle-label">{props.label}</span>
          <span className="w-toggle-state">{on ? (props.onText || "on") : (props.offText || "off")}</span>
        </button>
      );
    },
  },
});

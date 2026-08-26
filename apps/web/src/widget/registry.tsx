import { useState } from "react";
import { defineRegistry, useStateBinding } from "@json-render/react";
import { catalog } from "./catalog";

interface Step {
  label?: string;
  detail?: string;
  code?: string;
  highlightLine?: number;
  frames?: Record<string, string[]>;
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

    Heading: ({ props }: any) => <div className="w-heading">{props.value}</div>,

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
            <button onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous step">←</button>
            <div className="w-tl-dots">
              {steps.map((_, n) => (
                <button
                  key={n}
                  className={n === i ? "dot on" : n < i ? "dot done" : "dot"}
                  onClick={() => go(n)}
                  aria-label={`Step ${n + 1}`}
                />
              ))}
            </div>
            <button onClick={() => go(i + 1)} disabled={i === steps.length - 1} aria-label="Next step">→</button>
            <span className="w-tl-count">{i + 1} / {steps.length}</span>
          </div>
          {step.label && <div className="w-tl-label">{step.label}</div>}
          {step.code && <Code code={step.code} highlight={step.highlightLine} />}
          {step.detail && <p className="w-text">{step.detail}</p>}
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

      return (
        <div className="w-sim">
          <div className="w-tl-head">
            <button onClick={() => go(0)} disabled={i === 0} aria-label="Restart">⏮</button>
            <button onClick={() => go(i - 1)} disabled={i === 0} aria-label="Back">←</button>
            <div className="w-tl-dots">
              {steps.map((_, n) => (
                <button
                  key={n}
                  className={n === i ? "dot on" : n < i ? "dot done" : "dot"}
                  onClick={() => go(n)}
                  aria-label={`Tick ${n + 1}`}
                />
              ))}
            </div>
            <button onClick={() => go(i + 1)} disabled={i === steps.length - 1} aria-label="Forward">→</button>
            <span className="w-tl-count">{i + 1} / {steps.length}</span>
          </div>

          {props.code && (
            <Code code={props.code} language={props.language} highlight={step.highlightLine} />
          )}

          <div className="w-regions" style={{ gridTemplateColumns: `repeat(${regions.length}, minmax(0, 1fr))` }}>
            {regions.map((name) => {
              const items: string[] = step.regions?.[name] ?? [];
              const before: string[] = previous[name] ?? [];
              const isStack = stackish.has(name);
              const shown = isStack ? [...items].reverse() : items;
              return (
                <div className="w-region" key={name}>
                  <div className="w-region-title">{name}</div>
                  {shown.length === 0 ? (
                    <div className="w-frame empty">empty</div>
                  ) : (
                    <div className="w-frame-list">
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
      );
    },

    Compare: ({ props }: any) => (
      <div className="w-compare-wrap">
        <div className="w-compare">
          <div>
            <div className="w-heading">{props.leftTitle}</div>
            <Code code={props.leftCode} />
          </div>
          <div>
            <div className="w-heading">{props.rightTitle}</div>
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
      const options: { label: string; correct?: boolean; feedback?: string }[] = props.options ?? [];
      return (
        <div className="w-choice">
          <div className="w-heading">{props.question}</div>
          <div className="w-options">
            {options.map((o, i) => (
              <button
                key={i}
                className={
                  picked === null ? "w-opt" : picked === i ? (o.correct ? "w-opt right" : "w-opt wrong") : "w-opt dim"
                }
                onClick={() => setPicked(i)}
                disabled={picked !== null}
              >
                {o.label}
              </button>
            ))}
          </div>
          {picked !== null && (
            <p className={options[picked]?.correct ? "w-feedback right" : "w-feedback wrong"}>
              {options[picked]?.feedback ?? (options[picked]?.correct ? "Correct." : "Not quite.")}
            </p>
          )}
          {picked !== null && !options[picked]?.correct && (
            <button className="linkish" onClick={() => setPicked(null)}>try again</button>
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

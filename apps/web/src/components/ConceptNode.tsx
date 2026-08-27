import { Handle, Position, useStore, type NodeProps } from "@xyflow/react";
import type { Mastery } from "../api";
import { ORB_W, orbDotSize } from "../force";

export interface ConceptNodeData extends Record<string, unknown> {
  name: string;
  mastery: Mastery | null;
  inferred: boolean;
  unlocks: number;
  degree: number;
  mode: "explore" | "teach";
  dimmed: boolean;
  isFocus: boolean;
}

const COLOR: Record<Mastery, string> = {
  unknown: "var(--m-unknown)",
  familiar: "var(--m-familiar)",
  functional: "var(--m-functional)",
  solid: "var(--m-solid)",
};

/**
 * Below this the 11px label draws under 5px, which is decoration rather than text.
 *
 * Not an edge case: a ~78-node explore layout fits at roughly 0.2–0.7, so the fitted
 * view was always inside the illegible band and nothing here read zoom.
 */
const LABEL_ZOOM = 0.42;

export function ConceptNode({ data, selected }: NodeProps) {
  const d = data as ConceptNodeData;
  // The label lives in graph space, so its screen size follows the viewport transform
  // unless it is counter-scaled back out of it.
  const zoom = useStore(
    (s) => s.transform[2],
    // Quantised to 5% steps: an exact subscription re-rendered all ~78 nodes on every
    // wheel tick, and a label 5% off its ideal size is not a thing anyone can see.
    (a, b) => Math.round(a * 20) === Math.round(b * 20),
  );
  // A null state means "no learner selected", not "assessed as unknown" — filling these
  // with the unknown swatch told a first-time visitor they know nothing.
  const unstated = d.mastery === null;
  const fill = d.mastery ? COLOR[d.mastery] : "transparent";

  if (d.mode === "explore") {
    const r = orbDotSize(d.degree);
    const showLabel = zoom >= LABEL_ZOOM;
    // Capped at the tier boundary so a counter-scaled label cannot grow past the width
    // the collide radius reserved for it.
    const scale = Math.min(1 / zoom, 1 / LABEL_ZOOM);
    return (
      <div
        className={
          "orb" +
          (selected ? " selected" : "") +
          (d.dimmed ? " dimmed" : "") +
          (d.isFocus ? " focus" : "")
        }
        style={{ width: ORB_W }}
        title={d.name}
      >
        {/* Not connectable: this graph is authored by the model, and a drag from a handle
            offered a connection the app has no endpoint to accept. */}
        <Handle type="target" position={Position.Top} isConnectable={false} />
        <span
          className={`orb-dot${unstated ? " orb-dot--unstated" : ""}`}
          style={{
            width: r,
            height: r,
            background: fill,
            borderColor: d.isFocus ? "var(--accent)" : undefined,
          }}
        />
        {showLabel && (
          <span className="orb-label" style={{ transform: `scale(${scale})`, maxWidth: ORB_W }}>
            {d.name}
          </span>
        )}
        <Handle type="source" position={Position.Bottom} isConnectable={false} />
      </div>
    );
  }

  return (
    <div className={`node${selected ? " selected" : ""}${d.dimmed ? " dimmed" : ""}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="n-name">{d.name}</div>
      <div className="n-meta">
        {/* The shared mark carries a shape as well as a hue; two of the four swatches are
            1.13:1 apart, so colour cannot be the only channel. */}
        <span className="mastery-mark" data-level={d.mastery ?? "unstated"} />
        <span>{d.mastery ?? "not assessed"}</span>
        {d.inferred && <span title="credited by inference, never demonstrated">inf</span>}
        {d.unlocks > 0 && <span title="concepts this unblocks">↓{d.unlocks}</span>}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Mastery } from "../api";

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

export function ConceptNode({ data, selected }: NodeProps) {
  const d = data as ConceptNodeData;
  const fill = d.mastery ? COLOR[d.mastery] : "var(--m-unknown)";

  if (d.mode === "explore") {
    // Size carries degree, so hubs read as hubs at a glance without a legend.
    const r = Math.min(34, 15 + d.degree * 2.2);
    return (
      <div
        className={`orb${selected ? " selected" : ""}${d.dimmed ? " dimmed" : ""}${d.isFocus ? " focus" : ""}`}
        title={d.name}
      >
        <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
        <span
          className="orb-dot"
          style={{ width: r, height: r, background: fill, borderColor: d.isFocus ? "var(--accent)" : undefined }}
        />
        <span className="orb-label">{d.name}</span>
        <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      </div>
    );
  }

  return (
    <div className={`node${selected ? " selected" : ""}${d.dimmed ? " dimmed" : ""}`}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="n-name">{d.name}</div>
      <div className="n-meta">
        <span className="mdot" style={{ background: fill }} />
        <span>{d.mastery ?? "—"}</span>
        {d.inferred && <span title="credited by inference, never demonstrated">inf</span>}
        {d.unlocks > 0 && <span title="concepts this unblocks">↓{d.unlocks}</span>}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

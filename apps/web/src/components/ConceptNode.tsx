import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { Mastery } from "../api";

export interface ConceptNodeData extends Record<string, unknown> {
  name: string;
  mastery: Mastery | null;
  confidence: number | null;
  inferred: boolean;
  topics: string[];
  unlocks: number;
}

const COLOR: Record<Mastery, string> = {
  unknown: "var(--m-unknown)",
  familiar: "var(--m-familiar)",
  functional: "var(--m-functional)",
  solid: "var(--m-solid)",
};

export function ConceptNode({ data, selected }: NodeProps) {
  const d = data as ConceptNodeData;
  return (
    <div className={`node${selected ? " selected" : ""}`}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="n-name">{d.name}</div>
      <div className="n-meta">
        <span
          className="mdot"
          style={{ background: d.mastery ? COLOR[d.mastery] : "var(--m-unknown)" }}
          title={d.mastery ? `${d.mastery}${d.inferred ? " (inferred)" : ""}` : "no learner selected"}
        />
        <span>{d.mastery ?? "—"}</span>
        {d.inferred && <span title="credited by backwards propagation, never demonstrated">inf</span>}
        {d.unlocks > 0 && <span title="target concepts this unblocks">↓{d.unlocks}</span>}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

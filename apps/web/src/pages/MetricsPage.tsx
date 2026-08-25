import { useEffect, useState } from "react";
import { api } from "../api";

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="card">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(3)}`);

export function MetricsPage() {
  const [m, setM] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.metrics().then(setM).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <div className="page"><p className="err">{error}</p></div>;
  if (!m) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      {m.providers.degraded && (
        <div className="banner">
          Running with stub providers{m.providers.llm ? "" : " and no model key"}. Nothing here
          reflects live model behaviour — the numbers describe seeded and test data only.
        </div>
      )}

      <h2 className="section-title">Graph</h2>
      <div className="cards">
        <Stat k="concepts" v={String(m.graph.concepts)} />
        <Stat k="hard edges" v={String(m.graph.hardEdges)} sub={`${m.graph.softEdges} soft`} />
        <Stat
          k="reuse rate" v={pct(m.reuse.reuseRate)}
          sub={`${m.reuse.bound} bound / ${m.reuse.proposals} proposals`}
        />
        <Stat k="learners" v={String(m.counts.learners)} sub={`${m.counts.evidence} evidence events`} />
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        Reuse rate is the earliest falsification signal for the whole premise: if a second
        overlapping topic still creates almost entirely new concepts, the graph is not being
        shared, and that shows up in week one rather than month twelve.
      </p>

      <h2 className="section-title">Teaching</h2>
      <div className="cards">
        <Stat
          k="wasted teaching" v={pct(m.waste.wasteRate)}
          sub={`${m.waste.alreadyKnew} already knew · ${m.waste.taughtIntoGap} taught into a gap`}
        />
        <Stat
          k="cross-session persistence" v={m.persistence.concepts === 0 ? "—" : pct(m.persistence.persistenceRate)}
          sub={`${m.persistence.held}/${m.persistence.concepts} re-probes held`}
        />
        <Stat k="open proposals" v={String(m.counts.openProposals)} />
      </div>

      <h2 className="section-title">Cost per verified outcome</h2>
      <div className="cards">
        <Stat k="total spend" v={usd(m.cost.totalCostUsd)} />
        <Stat
          k="per concept mastered" v={usd(m.cost.costPerConceptMastered)}
          sub={`${m.cost.conceptsMastered} mastered`}
        />
        <Stat
          k="per milestone" v={usd(m.cost.costPerMilestone)}
          sub={`${m.cost.milestonesCompleted} completed`}
        />
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        Per outcome, never per hour — cost per hour can be improved by teaching cheaply and
        badly. The hypothesis is that this falls as the graph and item bank accumulate,
        while the baseline arm stays flat forever.
      </p>

      {m.cost.byPurpose.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Purpose</th><th>Calls</th><th>Cost</th></tr></thead>
          <tbody>
            {m.cost.byPurpose.map((p: any) => (
              <tr key={p.purpose}>
                <td className="mono">{p.purpose}</td>
                <td className="mono">{p.calls}</td>
                <td className="mono">{usd(p.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="section-title">Arms</h2>
      {m.arms.length === 0 ? (
        <div className="empty">No sessions yet — nothing to compare.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Variant</th><th>Learners</th><th>Mastered</th><th>Per learner</th></tr>
          </thead>
          <tbody>
            {m.arms.map((a: any) => (
              <tr key={a.variant}>
                <td className="mono">{a.variant}</td>
                <td className="mono">{a.learners}</td>
                <td className="mono">{a.conceptsMastered}</td>
                <td className="mono">{a.masteredPerLearner.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {m.reuseByTopic.length > 0 && (
        <>
          <h2 className="section-title">Reuse by topic</h2>
          <table>
            <thead><tr><th>Topic</th><th>Proposals</th><th>Reuse</th></tr></thead>
            <tbody>
              {m.reuseByTopic.map((t: any) => (
                <tr key={t.topic}>
                  <td>{t.topic}</td>
                  <td className="mono">{t.proposals}</td>
                  <td className="mono">{pct(t.reuseRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

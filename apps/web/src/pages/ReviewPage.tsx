import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

export function ReviewPage() {
  const [proposals, setProposals] = useState<any[]>([]);
  const [queue, setQueue] = useState<any[]>([]);
  const [negative, setNegative] = useState<any>(null);
  const [failureModes, setFailureModes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, q, n] = await Promise.all([api.proposals(), api.reviewQueue(), api.negative()]);
    setProposals(p); setQueue(q); setNegative(n);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const scan = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api.scan();
      const proposed = r.results.filter((x: any) => x.proposed).length;
      setNote(
        `Scanned ${r.scanned} candidate edge(s); ${proposed} met the bar. ` +
        (r.scanned > proposed ? "Near misses are listed with why they failed." : ""),
      );
      await load();
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const accept = async (id: string) => {
    const fm = failureModes[id]?.trim();
    if (!fm) { setNote("A hard edge needs a concrete failure mode before it can be accepted."); return; }
    setBusy(true); setNote(null);
    try { await api.acceptProposal(id, fm); setNote("Accepted — edge written as provisional."); await load(); }
    catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const open = proposals.filter((p) => p.status === "open");

  return (
    <div className="page">
      <div className="banner">
        Structural changes are proposals, never automatic writes. Accepting one requires a
        concrete failure mode and produces a <em>provisional</em> edge that can be reversed.
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <button className="primary" onClick={() => void scan()} disabled={busy}>
          Scan evidence for missing edges
        </button>
        <button onClick={() => void load()} disabled={busy}>Refresh</button>
      </div>
      {note && <div className="banner">{note}</div>}

      <h2 className="section-title">Open proposals ({open.length})</h2>
      {open.length === 0 ? (
        <div className="empty">
          Nothing pending. A proposal appears when learners repeatedly behave as though an
          edge exists <em>and</em> the control comparison supports it.
        </div>
      ) : (
        <table>
          <thead>
            <tr><th>Edge</th><th>Claim</th><th>Effect</th><th>Failure mode</th><th /></tr>
          </thead>
          <tbody>
            {open.map((p) => (
              <tr key={p.id}>
                <td>{p.src} → {p.dst}</td>
                <td className="muted">{p.claim}</td>
                <td className="mono">
                  {p.effectSize.toFixed(2)}
                  <div className="muted" style={{ fontSize: 11 }}>
                    {p.distinctLearners} learners · {p.distinctGoals} goals
                  </div>
                </td>
                <td>
                  <textarea
                    rows={3} style={{ width: 240 }}
                    placeholder="What specifically goes wrong without it?"
                    value={failureModes[p.id] ?? ""}
                    onChange={(e) => setFailureModes({ ...failureModes, [p.id]: e.target.value })}
                  />
                </td>
                <td>
                  <button className="primary" onClick={() => void accept(p.id)} disabled={busy}>Accept</button>{" "}
                  <button onClick={() => void api.rejectProposal(p.id).then(load)} disabled={busy}>Reject</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="section-title">Looks like invention</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        The graph starts as model assertion, so pruning fiction is worth more early than
        adding more claims.
      </p>
      {negative && negative.unobserved.length === 0 && negative.bypassed.length === 0 ? (
        <div className="empty">Nothing flagged — or not enough traffic yet to judge.</div>
      ) : (
        <table>
          <thead><tr><th>Edge</th><th>Signal</th><th>Detail</th></tr></thead>
          <tbody>
            {negative?.unobserved.map((u: any) => (
              <tr key={u.edgeId}>
                <td>{u.srcName} → {u.dstName}</td>
                <td className="mono">unobserved failure mode</td>
                <td className="muted">{u.attempts} attempts, never once exhibited: “{u.failureMode}”</td>
              </tr>
            ))}
            {negative?.bypassed.map((b: any) => (
              <tr key={b.edgeId}>
                <td>{b.srcName} → {b.dstName}</td>
                <td className="mono">routinely bypassed</td>
                <td className="muted">
                  {(b.bypassRate * 100).toFixed(0)}% of {b.total} learners succeeded without it
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="section-title">Review queue by traversal</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Most of the graph is never crossed by anyone; reviewing that is wasted attention.
      </p>
      {queue.length === 0 ? (
        <div className="empty">No hard edges yet.</div>
      ) : (
        <table>
          <thead><tr><th>Edge</th><th>Plans crossing it</th><th>Status</th></tr></thead>
          <tbody>
            {queue.slice(0, 25).map((q) => (
              <tr key={q.edgeId}>
                <td>{q.srcName} → {q.dstName}</td>
                <td className="mono">{q.traversals}</td>
                <td className="mono muted">{q.provisional ? "provisional" : "canonical"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

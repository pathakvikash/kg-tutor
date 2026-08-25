import { useEffect, useState } from "react";
import { api } from "../api";

export function SettingsPage() {
  const [data, setData] = useState<any>(null);
  const [provider, setProvider] = useState("");
  const [small, setSmall] = useState("");
  const [strong, setStrong] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api.modelSettings().then((d) => {
      setData(d);
      setProvider(d.current.provider);
      setSmall(d.current.small);
      setStrong(d.current.strong);
    });

  useEffect(() => { void load(); }, []);

  const entry = data?.catalog?.[provider];

  const save = async () => {
    setBusy(true); setNote(null); setError(null);
    try {
      await api.setModel({ provider, small, strong });
      setNote("Saved. It takes effect on the next model call — no restart needed.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <div style={{ maxWidth: 620 }}>
        <h2 className="section-title">Model</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Two tiers, per decision 17. The <strong>small</strong> tier handles grading,
          failure-mode classification and chat routing — narrow, rubric-bound work where a
          large model is more likely to charitably reinterpret a bad answer into a good
          one. The <strong>strong</strong> tier handles graph expansion, explanation
          adaptation and novel diagnosis.
        </p>

        <label className="intake-field">
          <span>Provider</span>
          <select value={provider} onChange={(e) => {
            setProvider(e.target.value);
            const models = data.catalog[e.target.value]?.models ?? [];
            setSmall(models[0] ?? "");
            setStrong(models[models.length - 1] ?? "");
          }}>
            {Object.entries(data.catalog).map(([k, v]: [string, any]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
            <option value="none">None (disable model calls)</option>
          </select>
          {entry?.note && <em className="muted hint">{entry.note}</em>}
        </label>

        {provider !== "none" && (
          <>
            <label className="intake-field">
              <span>Small tier — grading, classification, routing</span>
              <select value={small} onChange={(e) => setSmall(e.target.value)}>
                {(entry?.models ?? []).map((m: string) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="intake-field">
              <span>Strong tier — expansion, explanation, diagnosis</span>
              <select value={strong} onChange={(e) => setStrong(e.target.value)}>
                {(entry?.models ?? []).map((m: string) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </>
        )}

        {note && <div className="banner">{note}</div>}
        {error && <p className="err">{error}</p>}
        <button className="primary" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>

        <h2 className="section-title">Current state</h2>
        <table>
          <tbody>
            <tr><td>Model</td><td className="mono">{data.status.llm ?? "none"}</td></tr>
            <tr><td>Embeddings</td><td className="mono">{data.status.embedding}</td></tr>
          </tbody>
        </table>
        {data.status.caveats?.length > 0 && (
          <>
            <h4 style={{ marginTop: 18 }}>Caveats</h4>
            <ul className="muted">
              {data.status.caveats.map((c: string, i: number) => <li key={i}>{c}</li>)}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

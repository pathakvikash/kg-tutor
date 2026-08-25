import { useEffect, useState } from "react";
import { BrowserRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { GraphPage } from "./pages/GraphPage";
import { LearnerPage } from "./pages/LearnerPage";
import { ReviewPage } from "./pages/ReviewPage";
import { MetricsPage } from "./pages/MetricsPage";

function ProviderBadge() {
  const [status, setStatus] = useState<{ llm: string | null; degraded: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);
  if (!status) return null;
  return status.llm ? (
    <span className="badge" title={status.llm}>model: {status.llm.split(":")[0]}</span>
  ) : (
    <span className="badge warn" title="Expansion, grading and chat return 503 without a key">
      no model key
    </span>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <header className="topbar">
          <span className="brand">kg-tutor</span>
          <nav className="nav">
            <NavLink to="/graph">Graph</NavLink>
            <NavLink to="/learner">Learner</NavLink>
            <NavLink to="/review">Review</NavLink>
            <NavLink to="/metrics">Metrics</NavLink>
          </nav>
          <span className="spacer" />
          <ProviderBadge />
        </header>
        <Routes>
          <Route path="/" element={<Navigate to="/graph" replace />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/learner" element={<LearnerPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/metrics" element={<MetricsPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

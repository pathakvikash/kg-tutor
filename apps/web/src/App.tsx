import { useEffect, useState } from "react";
import { BrowserRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { GraphPage } from "./pages/GraphPage";
import { LearnPage } from "./pages/LearnPage";
import { LearnerPage } from "./pages/LearnerPage";
import { ReviewPage } from "./pages/ReviewPage";
import { MetricsPage } from "./pages/MetricsPage";
import { SettingsPage } from "./pages/SettingsPage";

function ProviderBadge() {
  const [status, setStatus] = useState<{ llm: string | null; degraded: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);
  if (!status) return null;
  return (
    <NavLink to="/settings" className={status.llm ? "badge" : "badge warn"} title={status.llm ?? "no model configured"}>
      {status.llm ? `model: ${status.llm.split(":")[0]}` : "no model — click to set"}
    </NavLink>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <header className="topbar">
          <span className="brand">kg-tutor</span>
          <nav className="nav">
            <NavLink to="/learn">Learn</NavLink>
            <NavLink to="/graph">Graph</NavLink>
            <NavLink to="/learner">Learner</NavLink>
            <NavLink to="/review">Review</NavLink>
            <NavLink to="/metrics">Metrics</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <span className="spacer" />
          <ProviderBadge />
        </header>
        <Routes>
          <Route path="/" element={<Navigate to="/learn" replace />} />
          <Route path="/learn" element={<LearnPage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/learner" element={<LearnerPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/metrics" element={<MetricsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

import { useEffect, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { GraphPage } from "./pages/GraphPage";
import { LearnPage } from "./pages/LearnPage";
import { LearnerPage } from "./pages/LearnerPage";
import { ReviewPage } from "./pages/ReviewPage";
import { MetricsPage } from "./pages/MetricsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ReviewSessionPage } from "./pages/ReviewSessionPage";
import { api } from "./api";
import { useStickyLearner } from "./useLearner";

/**
 * How much has gone stale, in the nav.
 *
 * The queue existed as data and nowhere on screen, so it could only grow. A number next
 * to the link is the whole mechanism by which spaced review actually happens.
 */
function DueBadge() {
  const [learnerId] = useStickyLearner();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!learnerId) return;
    let cancelled = false;
    const check = () => {
      void api.due(learnerId, 50)
        .then((d) => { if (!cancelled) setCount(d.total ?? 0); })
        .catch(() => undefined);
    };
    check();
    // Slow on purpose: decay is measured in days, so this is about picking up an answer
    // graded a moment ago, not about polling.
    const timer = setInterval(check, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [learnerId]);
  if (count === 0) return null;
  return <span className="due-badge" title={`${count} concept(s) due for review`}>{count}</span>;
}

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
            <NavLink to="/" end>Home</NavLink>
            <NavLink to="/learn">Learn</NavLink>
            <NavLink to="/graph">Graph</NavLink>
            <NavLink to="/review-session" className="with-badge">
              Review<DueBadge />
            </NavLink>
            <NavLink to="/learner">Learner</NavLink>
            {/* Renamed: this one curates the graph, it is not the learner's review. */}
            <NavLink to="/review">Curate</NavLink>
            <NavLink to="/metrics">Metrics</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <span className="spacer" />
          <ProviderBadge />
        </header>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/review-session" element={<ReviewSessionPage />} />
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

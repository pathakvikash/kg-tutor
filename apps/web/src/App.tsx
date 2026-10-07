import { useEffect, useRef, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { GraphPage } from "./pages/GraphPage";
import { LearnPage } from "./pages/LearnPage";
import { LearnerPage } from "./pages/LearnerPage";
import { ReviewPage } from "./pages/ReviewPage";
import { MetricsPage } from "./pages/MetricsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ReviewSessionPage } from "./pages/ReviewSessionPage";
import { api, apiUrl } from "./api";
import { useLearner } from "./learnerStore";
import { ErrorBoundary } from "./components/ErrorBoundary";

function DueBadge() {
  const [learnerId] = useLearner();
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
    // Decay is measured in days, so a minute between checks is plenty
    const timer = setInterval(check, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [learnerId]);
  if (count === 0) return null;
  return <span className="due-badge" title={`${count} concept(s) due for review`}>{count}</span>;
}

type Health = { llm: string | null; degraded: boolean };

function ProviderBadge() {
  // A 500 can still parse as JSON, so check both res.ok and the shape
  const [state, setState] = useState<"loading" | "unreachable" | Health>("loading");
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/api/health"))
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const body = (await r.json()) as Partial<Health>;
        if (typeof body.llm === "undefined") throw new Error("unrecognised health payload");
        return body as Health;
      })
      .then((h) => { if (!cancelled) setState(h); })
      .catch(() => { if (!cancelled) setState("unreachable"); });
    return () => { cancelled = true; };
  }, []);

  if (state === "loading") return null;
  if (state === "unreachable") {
    return (
      <span className="badge warn" title="The API did not answer /api/health.">
        backend unreachable
      </span>
    );
  }
  return (
    <NavLink
      to="/settings"
      className={state.llm ? "badge" : "badge warn"}
      title={state.llm ?? "No model configured — open Settings to choose one."}
    >
      {state.llm ? `model: ${state.llm.split(":")[0]}` : "no model — click to set"}
    </NavLink>
  );
}

const TITLES: Record<string, string> = {
  "/": "Home",
  "/learn": "Learn",
  "/graph": "Graph",
  "/review-session": "Review",
  "/learner": "Learner",
  "/review": "Curate",
  "/metrics": "Metrics",
  "/settings": "Settings",
};

function RouteChrome({ mainRef }: { mainRef: React.RefObject<HTMLElement | null> }) {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    document.title = `${TITLES[pathname] ?? "kg-tutor"} · kg-tutor`;
    if (first.current) { first.current = false; return; }
    mainRef.current?.focus();
    document.querySelector(".nav a.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname, mainRef]);
  return null;
}

export function App() {
  const mainRef = useRef<HTMLElement | null>(null);
  return (
    <BrowserRouter>
      <div className="app">
        <a className="skip-link" href="#main">Skip to main content</a>
        <RouteChrome mainRef={mainRef} />
        <header className="topbar">
          <span className="brand">kg-tutor</span>
          <nav className="nav" aria-label="Sections">
            <NavLink to="/" end>Home</NavLink>
            <NavLink to="/learn">Learn</NavLink>
            <NavLink to="/graph">Graph</NavLink>
            <NavLink to="/review-session" className="with-badge">
              Review<DueBadge />
            </NavLink>
            <NavLink to="/learner">Learner</NavLink>
            <NavLink to="/review">Curate</NavLink>
            <NavLink to="/metrics">Metrics</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <span className="spacer" />
          <ProviderBadge />
        </header>
        <main id="main" ref={mainRef} tabIndex={-1} className="app-main">
        <ErrorBoundary where="route">
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
        </ErrorBoundary>
        </main>
      </div>
    </BrowserRouter>
  );
}

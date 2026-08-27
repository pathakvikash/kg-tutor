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
import { api } from "./api";
import { useLearner } from "./learnerStore";
import { ErrorBoundary } from "./components/ErrorBoundary";

/**
 * How much has gone stale, in the nav.
 *
 * The queue existed as data and nowhere on screen, so it could only grow. A number next
 * to the link is the whole mechanism by which spaced review actually happens.
 */
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
    // Slow on purpose: decay is measured in days, so this is about picking up an answer
    // graded a moment ago, not about polling.
    const timer = setInterval(check, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [learnerId]);
  if (count === 0) return null;
  return <span className="due-badge" title={`${count} concept(s) due for review`}>{count}</span>;
}

type Health = { llm: string | null; degraded: boolean };

function ProviderBadge() {
  /**
   * Three states, not two. This checked neither res.ok nor the shape, so when the API
   * returned 500 with a parseable JSON error body — which it does when the database is
   * down — `llm` came back undefined and the badge confidently advised the user to go
   * and configure a model. The model was fine; the backend was not.
   */
  const [state, setState] = useState<"loading" | "unreachable" | Health>("loading");
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
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

/**
 * Route-change housekeeping the app was missing entirely.
 *
 * One static <title> served eight pages, so browser history and tab switching gave no
 * clue where you were; and after navigating, keyboard focus stayed wherever the link
 * had been, so a screen reader announced nothing and Tab resumed mid-nav.
 */
function RouteChrome({ mainRef }: { mainRef: React.RefObject<HTMLElement | null> }) {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    document.title = `${TITLES[pathname] ?? "kg-tutor"} · kg-tutor`;
    // Not on first paint: stealing focus on load is its own annoyance.
    if (first.current) { first.current = false; return; }
    mainRef.current?.focus();
    // The active link may be scrolled out of the horizontally-scrolling nav.
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
            {/* Renamed: this one curates the graph, it is not the learner's review. */}
            <NavLink to="/review">Curate</NavLink>
            <NavLink to="/metrics">Metrics</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <span className="spacer" />
          <ProviderBadge />
        </header>
        {/* tabIndex -1 so route changes can move focus here without making it a tab stop */}
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

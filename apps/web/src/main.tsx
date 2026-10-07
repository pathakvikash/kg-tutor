import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// styles.css names these families and nothing else loads them
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/zilla-slab/500.css";
import "@fontsource/zilla-slab/600.css";
import "@fontsource/zilla-slab/700.css";
import "@xyflow/react/dist/style.css";
import "./styles.css";

import "./styles/home.css";
import "./styles/learn.css";
import "./styles/graph.css";
import "./styles/review-session.css";
import "./styles/learner.css";
import "./styles/curate.css";
import "./styles/metrics.css";
import "./styles/settings.css";
import "./styles/transcript.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

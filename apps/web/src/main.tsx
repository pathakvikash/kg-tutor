import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
/**
 * The typefaces the stylesheet has always asked for and never had.
 *
 * styles.css named "IBM Plex Sans", "IBM Plex Mono" and "Zilla Slab" from the start, but
 * nothing loaded them: no @font-face, no link in index.html, no dependency. So every
 * heading rendered Georgia and all 35 mono labels rendered Menlo — which is 26% wider at
 * the same size, and is the metric every hand-tuned size, wrap threshold and chip padding
 * in this stylesheet was accidentally tuned against. Self-hosted rather than a CDN link
 * so the app renders identically offline and nothing blocks first paint on a third party.
 */
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

/* Page-scoped sheets, loaded after the base so a page can override a primitive
   deliberately. One file per page keeps parallel work from colliding. */
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

import { Component, type ErrorInfo, type ReactNode } from "react";

/** Wraps each route, so one page's throw cannot white-screen the shell. */
export class ErrorBoundary extends Component<
  { children: ReactNode; where: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept: a white screen with a silent console is the worst of both.
    console.error(`[${this.props.where}] render failed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page page--measure">
        <div className="notice notice--error" role="alert">
          <strong>This page could not be drawn.</strong>
          <p style={{ margin: 0 }}>
            {this.state.error.message || "An unexpected error."} The rest of the app is
            still working — the navigation above still moves.
          </p>
        </div>
        <div className="row" style={{ marginTop: "var(--s-4)" }}>
          <button className="primary" onClick={() => this.setState({ error: null })}>
            Try drawing it again
          </button>
          <button onClick={() => window.location.reload()}>Reload the app</button>
        </div>
      </div>
    );
  }
}

import { Component, type ErrorInfo, type ReactNode } from "react";

export class ErrorBoundary extends Component<
  { children: ReactNode; where: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.where}] render failed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page page--measure stack stack--loose">
        <div className="notice notice--error" role="alert">
          <strong>Something went wrong on this page.</strong>
          <p>The rest of the app still works.</p>
          {this.state.error.message && (
            <details>
              <summary>Details</summary>
              <p className="mono">{this.state.error.message}</p>
            </details>
          )}
        </div>
        <div className="row">
          <button className="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button onClick={() => window.location.reload()}>Reload the app</button>
        </div>
      </div>
    );
  }
}

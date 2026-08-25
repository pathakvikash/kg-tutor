import { Component, type ReactNode } from "react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { registry } from "./registry";

/**
 * A model-authored spec is untrusted input. A malformed one must degrade to "the widget
 * did not render" rather than taking the whole lesson down with it.
 */
class WidgetBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { failed: err instanceof Error ? err.message : String(err) };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="w-failed">
          This interactive example could not be rendered. The explanation above still
          stands. <span className="mono">{this.state.failed}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

export function Widget({ spec }: { spec: any }) {
  if (!spec?.root || !spec?.elements) return null;
  return (
    <div className="w-root">
      <WidgetBoundary>
        <JSONUIProvider registry={registry} initialState={spec.state ?? {}}>
          <Renderer spec={spec} registry={registry} />
        </JSONUIProvider>
      </WidgetBoundary>
    </div>
  );
}

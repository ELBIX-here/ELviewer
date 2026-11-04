import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Last-resort error screen so a render crash never leaves a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error("Render error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const e = this.state.error;
    return (
      <div className="center" style={{ padding: 40 }}>
        <div className="error-box" style={{ maxWidth: 720, textAlign: "left" }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>오류가 발생했습니다</div>
          <div style={{ fontSize: 13, color: "var(--danger)", wordBreak: "break-all" }}>{String(e.message || e)}</div>
          <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto", color: "var(--muted)" }}>{e.stack}</pre>
          <button
            className="btn primary"
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset?.();
            }}
          >
            서재로 돌아가기
          </button>
        </div>
      </div>
    );
  }
}

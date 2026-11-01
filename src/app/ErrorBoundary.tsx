import React, { Component, ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("VistoGallery caught a render error:", error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--surface, #ffffff)",
            color: "var(--text, #000000)",
            zIndex: 10000,
            padding: 24,
            textAlign: "center",
          }}
        >
          <h2 style={{ marginBottom: 12 }}>VistoGallery encountered an error</h2>
          <p style={{ marginBottom: 20, maxWidth: 420, opacity: 0.85 }}>
            {this.state.errorMessage ||
              "An unexpected error occurred while rendering the UI."}
          </p>
          <button
            type="button"
            onClick={() => {
              this.setState({ hasError: false, errorMessage: null });
            }}
            style={{
              padding: "8px 16px",
              cursor: "pointer",
              background: "var(--accent, #3474d4)",
              color: "white",
              border: "none",
              borderRadius: 6,
              fontSize: 14,
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

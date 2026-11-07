import React, { Component, ErrorInfo, ReactNode } from "react";
import { tauri } from "../engine/commands/tauri";
import {
  buildCrashReport,
  formatCrashReport,
  issueUrl,
  readCrashReport,
  storeCrashReport,
  type CrashReport,
} from "./crashReport";

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
  crashReport: CrashReport | null;
  copied: boolean;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea path */
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: null, crashReport: null, copied: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message,
      crashReport: null,
      copied: false,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const report = buildCrashReport(error, errorInfo);
    storeCrashReport(report);
    // eslint-disable-next-line no-console
    console.error("VistoGallery caught a render error:", error, errorInfo);
    this.setState({ crashReport: report });
  }

  private handleCopy = async () => {
    if (!this.state.crashReport) return;
    const ok = await copyText(formatCrashReport(this.state.crashReport));
    if (ok) {
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 2500);
    }
  };

  private handleReport = () => {
    const report = this.state.crashReport ?? readCrashReport();
    if (!report) return;
    const url = issueUrl(report);
    void tauri.app.openExternal(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      const report = this.state.crashReport ?? readCrashReport();
      return (
        <div
          role="alert"            style={{
              position: "fixed",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              background: "light-dark(#ffffff, #111827)",
              color: "light-dark(#111827, #f9fafb)",
              colorScheme: "light dark",
              zIndex: 10000,
              padding: 24,
              textAlign: "center",
            }}
        >
          <h2 style={{ marginBottom: 12 }}>VistoGallery encountered an error</h2>
          <p style={{ marginBottom: 16, maxWidth: 420, opacity: 0.85 }}>
            {this.state.errorMessage || "An unexpected error occurred while rendering the UI."}
          </p>
          {report && (
            <details
              style={{
                marginBottom: 16,
                maxWidth: 480,
                textAlign: "left",
                fontSize: 12,
                opacity: 0.85,
              }}
            >
              <summary>Diagnostic details</summary>
              <pre
                style={{
                  maxHeight: 200,
                  overflow: "auto",
                  background: "light-dark(rgba(17,24,39,0.06), rgba(249,250,251,0.08))",
                  color: "inherit",
                  padding: 8,
                  borderRadius: 6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {formatCrashReport(report)}
              </pre>
            </details>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            <button
              type="button"
              onClick={() => {
                this.setState({
                  hasError: false,
                  errorMessage: null,
                  crashReport: null,
                  copied: false,
                });
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
            <button
              type="button"
              onClick={() => void this.handleCopy()}
              style={{
                padding: "8px 16px",
                cursor: "pointer",
                background: "transparent",
                color: "inherit",
                border: "1px solid light-dark(rgba(17,24,39,0.25), rgba(249,250,251,0.28))",
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              {this.state.copied ? "Copied!" : "Copy error report"}
            </button>
            <button
              type="button"
              onClick={this.handleReport}
              style={{
                padding: "8px 16px",
                cursor: "pointer",
                background: "transparent",
                color: "inherit",
                border: "1px solid light-dark(rgba(17,24,39,0.25), rgba(249,250,251,0.28))",
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              Report on GitHub
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

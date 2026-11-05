import type { ErrorInfo } from "react";

/**
 * Crash diagnostics captured at the App boundary. Persisted to localStorage so
 * the report survives the "Try again" remount the user clicks to keep working,
 * and displayed (plus copyable / linkable to the issue tracker) on the error
 * screen so minified errors no longer require the dev build to diagnose.
 */
export interface CrashReport {
  capturedAt: string;
  errorName: string;
  errorMessage: string;
  errorStack: string | null;
  componentStack: string | null;
}

export const CRASH_REPORT_STORAGE_KEY = "visto-gallery:last-crash";

const MAX_FIELD = 1500;

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}\n… (truncated ${value.length - max} characters)` : value;
}

export function buildCrashReport(
  error: Error,
  errorInfo?: Pick<ErrorInfo, "componentStack"> | null,
): CrashReport {
  return {
    capturedAt: new Date().toISOString(),
    errorName: error.name || "Error",
    errorMessage: error.message || String(error),
    errorStack: truncate(error.stack ?? null, MAX_FIELD),
    componentStack: truncate(errorInfo?.componentStack ?? null, MAX_FIELD),
  };
}

export function formatCrashReport(report: CrashReport): string {
  const parts = [
    "VistoGallery crash report",
    `Captured: ${report.capturedAt}`,
    `${report.errorName}: ${report.errorMessage}`,
  ];
  if (report.errorStack) parts.push(`\nStack:\n${report.errorStack}`);
  if (report.componentStack) parts.push(`\nComponent stack:\n${report.componentStack}`);
  return parts.join("\n");
}

export function issueUrl(report: CrashReport): string {
  const body =
    `Crash report (copied automatically from the in-app report button)\n\n` +
    "```\n" +
    formatCrashReport(report) +
    "\n```\n";
  const title = `Crash: ${report.errorMessage.slice(0, 80)}`;
  return `https://github.com/Davin-X/visto-gallery/issues/new?title=${encodeURIComponent(
    title,
  )}&body=${encodeURIComponent(body)}`;
}

export function storeCrashReport(report: CrashReport): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CRASH_REPORT_STORAGE_KEY, JSON.stringify(report));
  } catch {
    // Diagnostics are best-effort: quota or privacy-mode must never take down the error screen.
  }
}

export function readCrashReport(): CrashReport | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CRASH_REPORT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CrashReport>;
    if (!parsed.errorMessage) return null;
    return {
      capturedAt: parsed.capturedAt ?? new Date().toISOString(),
      errorName: parsed.errorName ?? "Error",
      errorMessage: parsed.errorMessage ?? "Unknown error",
      errorStack: parsed.errorStack ?? null,
      componentStack: parsed.componentStack ?? null,
    };
  } catch {
    return null;
  }
}

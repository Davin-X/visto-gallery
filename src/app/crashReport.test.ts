/// <reference types="vitest/globals" />
import { describe, expect, it } from "vitest";
import {
  buildCrashReport,
  formatCrashReport,
  issueUrl,
  readCrashReport,
  storeCrashReport,
  CRASH_REPORT_STORAGE_KEY,
} from "./crashReport";

describe("crashReport", () => {
  it("captures error details and component stack", () => {
    const error = new Error("boom");
    const report = buildCrashReport(error, {
      componentStack: "\n    at Thrower\n    at ErrorBoundary",
    });
    expect(report.errorMessage).toBe("boom");
    expect(report.errorName).toBe("Error");
    expect(report.errorStack).toContain("boom");
    expect(report.componentStack).toContain("at Thrower");
  });

  it("formats a self-contained report", () => {
    const report = buildCrashReport(new Error("codec"), { componentStack: "\n    at Foo" });
    const text = formatCrashReport(report);
    expect(text).toContain("VistoGallery crash report");
    expect(text).toContain("codec");
    expect(text).toContain("Component stack");
  });

  it("links a prefilled GitHub issue", () => {
    const report = buildCrashReport(new Error("codec"), { componentStack: "\n    at Foo" });
    const url = issueUrl(report);
    expect(url).toContain("https://github.com/Davin-X/visto-gallery/issues/new?");
    expect(url).toContain(encodeURIComponent("codec"));
  });

  it("persists and reads back the last crash report", () => {
    window.localStorage.removeItem(CRASH_REPORT_STORAGE_KEY);
    const report = buildCrashReport(new Error("persisted"));
    storeCrashReport(report);
    const stored = readCrashReport();
    expect(stored?.errorMessage).toBe("persisted");
  });

  it("returns null when nothing has been captured", () => {
    window.localStorage.removeItem(CRASH_REPORT_STORAGE_KEY);
    expect(readCrashReport()).toBeNull();
  });
});
import type { CSSProperties, ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

interface AppShellProps {
  dark: boolean;
  animateTransitions: boolean;
  sidebarWidth: number;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  topbar: ReactNode;
  sidebar: ReactNode;
  overlays?: ReactNode;
  children: ReactNode;
}

export function AppShell({
  dark,
  animateTransitions,
  sidebarWidth,
  sidebarOpen,
  sidebarCollapsed,
  topbar,
  sidebar,
  overlays,
  children,
}: AppShellProps) {
  return (
    <ErrorBoundary>
      <div
        className={`app-frame ${dark ? "dark" : ""}${!animateTransitions ? " no-transitions" : ""}`}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <a className="skip-to-content" href="#main-content">
          Skip to main content
        </a>
        {topbar}
        <div
          className={`app-body ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}${
            sidebarCollapsed ? " sidebar-collapsed" : ""
          }`}
        >
          {sidebar}
          {children}
        </div>
        {overlays}
      </div>
    </ErrorBoundary>
  );
}

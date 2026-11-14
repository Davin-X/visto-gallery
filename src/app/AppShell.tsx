import type { CSSProperties, ReactNode } from "react";
import { useRef } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { PanelResizer } from "../design/components/PanelResizer";
import { useSettingsStore } from "../engine/stores/useSettingsStore";

interface AppShellProps {
  dark: boolean;
  animateTransitions: boolean;
  sidebarWidth: number;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  // A slideshow covers the whole window, so the top bar and its traffic-light
  // gutter stand down until it closes.
  slideshowOpen?: boolean;
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
  slideshowOpen = false,
  topbar,
  sidebar,
  overlays,
  children,
}: AppShellProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const updateSettings = useSettingsStore((s) => s.update);

  return (
    <ErrorBoundary>
      <div
        ref={frameRef}
        className={`app-frame ${dark ? "dark" : ""}${!animateTransitions ? " no-transitions" : ""}${
          slideshowOpen ? " slideshow-open" : ""
        }`}
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
          {!sidebarCollapsed && (
            <PanelResizer
              side="left"
              width={sidebarWidth}
              min={180}
              max={() => Math.min(360, window.innerWidth - 480)}
              cssVar="--sidebar-width"
              targetRef={frameRef}
              onCommit={(next) => void updateSettings("sidebarWidth", next)}
              defaultWidth={240}
              label="Resize sidebar"
            />
          )}
          {children}
        </div>
        {overlays}
      </div>
    </ErrorBoundary>
  );
}

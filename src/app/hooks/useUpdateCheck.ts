import { useCallback, useEffect, useRef, useState } from "react";
import { tauri } from "../../engine/commands/tauri";
import { useSettingsStore } from "../../engine/stores";
import type { ErrorCode, UpdateCheckResult } from "../../engine/types/commands";
import { shouldCheckForUpdatesOnLaunch } from "../startup";

interface UseUpdateCheckOptions {
  settingsHydrated: boolean;
  showNotice: (text: string, code?: ErrorCode) => void;
  showErrorNotice: (error: unknown, prefix?: string) => void;
  /** Close the About dialog when an update prompt replaces it. */
  setAboutOpen: (open: boolean) => void;
}

/**
 * App version, the update prompt's state, and the update check itself —
 * both the explicit Help menu check and the opt-in check on launch.
 */
export function useUpdateCheck({
  settingsHydrated,
  showNotice,
  showErrorNotice,
  setAboutOpen,
}: UseUpdateCheckOptions) {
  const [appVersion, setAppVersion] = useState("");
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  useEffect(() => {
    let cancelled = false;
    tauri.app
      .getVersion()
      .then((v) => {
        if (!cancelled) setAppVersion(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const checkForUpdates = useCallback(
    async (manual = false) => {
      if (manual) setUpdateChecking(true);
      try {
        const result = await tauri.app.checkUpdates(manual);
        if (!result.available) {
          if (manual) {
            showNotice(`You're up to date on v${result.currentVersion}.`);
          }
          return;
        }
        // Skipping a version silences the launch prompt only; an explicit
        // menu check should always surface it again.
        const skipped = localStorage.getItem(`update:skip:${result.latestVersion}`);
        if (!manual && skipped === "1") return;
        setUpdateInfo(result);
        setAboutOpen(false);
        setUpdateDialogOpen(true);
      } catch (error) {
        if (manual) {
          showErrorNotice(error, "Could not check for updates");
        }
      } finally {
        if (manual) setUpdateChecking(false);
      }
    },
    [showErrorNotice, showNotice, setAboutOpen],
  );

  // Automatic launch checks are opt-in and default off. The explicit Help menu
  // action bypasses this gate and always works.
  const checkForUpdatesOnLaunch = useSettingsStore((s) => s.checkForUpdatesOnLaunch);
  const didScheduleLaunchUpdate = useRef(false);
  useEffect(() => {
    if (!settingsHydrated || didScheduleLaunchUpdate.current) return;
    didScheduleLaunchUpdate.current = true;
    if (!shouldCheckForUpdatesOnLaunch({ checkForUpdatesOnLaunch })) return;
    // The backend caches the answer for 24 hours, so this stays well inside
    // GitHub's unauthenticated limit.
    const timer = window.setTimeout(() => {
      void checkForUpdates(false);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [settingsHydrated, checkForUpdatesOnLaunch, checkForUpdates]);

  return {
    appVersion,
    updateInfo,
    updateDialogOpen,
    setUpdateDialogOpen,
    updateChecking,
    checkForUpdates,
  };
}

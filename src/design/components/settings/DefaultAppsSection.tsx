import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon, ViewerIcon } from "../icons";
import { tauri } from "../../../engine/commands/tauri";
import { errorCode } from "../../../engine/types/errors";
import type {
  DefaultAppGroup,
  DefaultAppTarget,
  DefaultAppType,
  DefaultAppsStatus,
  ErrorCode,
} from "../../../engine/types/commands";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useKeyboard } from "../../../engine/hooks/useKeyboard";

const GROUPS: { id: Exclude<DefaultAppGroup, "other">; label: string; systemApp: string }[] = [
  { id: "photos", label: "Photos", systemApp: "Preview" },
  { id: "videos", label: "Videos", systemApp: "QuickTime Player" },
];

/** "JPEG", "JPEG and PNG", "JPEG, PNG and HEIC". */
export function listLabels(types: Pick<DefaultAppType, "label">[]): string {
  const labels = types.map((t) => t.label);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** What a group's row says opens its types now. */
export function groupStatus(types: DefaultAppType[]): string {
  const owned = types.filter((t) => t.isVisto).length;
  if (owned === types.length) return "VistoGallery";
  if (owned > 0) return `VistoGallery for ${owned} of ${types.length}`;
  const names = [...new Set(types.map((t) => t.handlerName ?? "No app"))];
  return names.join(", ");
}

/** The notice after a run: what changed, and where it stopped. */
export function runNotice(
  changed: DefaultAppType[],
  declined: DefaultAppType | null,
  appName: string,
): string {
  const verb = changed.length === 1 ? "opens" : "open";
  const done = changed.length ? `${listLabels(changed)} now ${verb} with ${appName}.` : "";
  if (!declined) return done;
  const stopped = `macOS kept the current app for ${declined.label}, so nothing else was asked.`;
  return done ? `${done} ${stopped}` : `Nothing changed. ${stopped}`;
}

interface PendingRun {
  types: DefaultAppType[];
  target: DefaultAppTarget;
  appName: string;
}

/**
 * Let Finder open photos and videos with VistoGallery. macOS confirms each
 * file type with its own dialog, so the groups are short, types already set
 * are never asked again, and a run stops at the first "keep".
 */
export function DefaultAppsSection(props: {
  showNotice: (text: string, code?: ErrorCode) => void;
}) {
  const { showNotice } = props;
  const [status, setStatus] = useState<DefaultAppsStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<PendingRun | null>(null);
  const [running, setRunning] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(!!pending, dialogRef);

  const refresh = useCallback(async () => {
    try {
      const next = await tauri.defaultApps.status();
      if (!Array.isArray(next?.types)) throw new Error("Default apps response has no file types");
      setStatus(next);
      setFailed(false);
    } catch {
      setStatus(null);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // A change made in Finder's Get Info shows up when the window comes back.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useKeyboard([
    useCallback(
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && pending) {
          e.preventDefault();
          setPending(null);
        }
      },
      [pending],
    ),
  ]);

  const run = useCallback(
    async ({ types, target, appName }: PendingRun) => {
      setPending(null);
      setRunning(true);
      const changed: DefaultAppType[] = [];
      let declined: DefaultAppType | null = null;
      try {
        // One at a time, so the system dialogs arrive one after another.
        for (const type of types) {
          const outcome = await tauri.defaultApps.set(type.uti, target);
          if (outcome !== "changed") {
            declined = type;
            break;
          }
          changed.push(type);
        }
        showNotice(runNotice(changed, declined, appName));
      } catch (error) {
        const message =
          error && typeof error === "object" && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);
        showNotice(`Could not change the default app: ${message}`, errorCode(error) ?? "internal");
      } finally {
        setRunning(false);
        void refresh();
      }
    },
    [refresh, showNotice],
  );

  /** Two or more dialogs get a heads-up first; a single one speaks for itself. */
  const request = (next: PendingRun) => {
    if (next.types.length === 0) return;
    if (next.types.length === 1) void run(next);
    else setPending(next);
  };

  const supported = status?.supported ?? false;
  const others = status?.types.filter((t) => t.group === "other") ?? [];

  return (
    <section className="settings-section" aria-label="Default apps">
      <h2 className="settings-section-title">
        <ViewerIcon size={14} /> Default apps
      </h2>
      <p className="settings-section-desc">
        Choose which files open in VistoGallery when you double-click them in Finder. macOS asks you
        to confirm each file type.
      </p>

      {failed && (
        <div className="settings-row">
          <div className="settings-row-label">
            <span className="settings-row-desc">Could not read the current default apps.</span>
          </div>
        </div>
      )}
      {status && !supported && (
        <div className="settings-row">
          <div className="settings-row-label">
            <span className="settings-row-desc">{status.unsupportedReason}</span>
          </div>
        </div>
      )}

      {(!status || supported) &&
        GROUPS.map((group) => {
          const types = status?.types.filter((t) => t.group === group.id) ?? [];
          const missing = types.filter((t) => !t.isVisto);
          const owned = types.filter((t) => t.isVisto);
          return (
            <div className="settings-row" key={group.id}>
              <div className="settings-row-label">
                <b>{group.label}</b>
                <span className="settings-row-desc">{types.length ? listLabels(types) : "…"}</span>
              </div>
              <div className="settings-row-control default-apps-control">
                <HandlerBadge
                  text={types.length ? groupStatus(types) : "…"}
                  isVisto={types.length > 0 && missing.length === 0}
                />
                {supported && missing.length > 0 && (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={running}
                    onClick={() =>
                      request({ types: missing, target: "visto", appName: "VistoGallery" })
                    }
                  >
                    Use VistoGallery
                  </button>
                )}
                {supported && missing.length === 0 && owned.length > 0 && (
                  <button
                    className="quiet-button"
                    type="button"
                    disabled={running}
                    onClick={() =>
                      request({ types: owned, target: "system", appName: group.systemApp })
                    }
                  >
                    Use {group.systemApp}
                  </button>
                )}
              </div>
            </div>
          );
        })}

      {supported && others.length > 0 && (
        <details className="default-apps-more">
          <summary className="settings-row">
            <div className="settings-row-label">
              <b>
                <ChevronRightIcon size={12} className="default-apps-chevron" /> All formats
              </b>
              <span className="settings-row-desc">
                GIF, WebP, TIFF, MKV and more, one type at a time
              </span>
            </div>
            <div className="settings-row-control default-apps-control">
              <span className="default-apps-count">
                {others.filter((t) => t.isVisto).length} of {others.length} open in VistoGallery
              </span>
            </div>
          </summary>
          <ul className="default-apps-list">
            {others.map((type) => (
              <li key={type.uti}>
                <b>{type.label}</b>
                <HandlerBadge
                  text={type.isVisto ? "VistoGallery" : (type.handlerName ?? "No app")}
                  isVisto={type.isVisto}
                />
                {!type.isVisto && (
                  <button
                    className="quiet-button"
                    type="button"
                    disabled={running}
                    aria-label={`Use VistoGallery for ${type.label}`}
                    onClick={() =>
                      request({ types: [type], target: "visto", appName: "VistoGallery" })
                    }
                  >
                    Use VistoGallery
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {running && (
        <p className="settings-section-desc" role="status">
          Waiting for macOS… answer the dialog to continue.
        </p>
      )}

      {pending && (
        <div className="dialog-backdrop" onClick={() => setPending(null)}>
          <div
            ref={dialogRef}
            className="album-dialog confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="default-apps-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">DEFAULT APPS</p>
                <h2 id="default-apps-title">
                  Open {listLabels(pending.types)} with {pending.appName}?
                </h2>
              </div>
            </div>
            <p className="dialog-body">
              macOS will ask you to confirm each file type, so you will see{" "}
              <b>{pending.types.length} dialogs</b>, one after another. If you keep the current app
              in one, the rest are skipped.
            </p>
            <div className="dialog-actions">
              <button type="button" className="quiet-button" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button type="button" className="primary-button" onClick={() => void run(pending)}>
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Who opens a type now, with a check when it is VistoGallery. */
function HandlerBadge(props: { text: string; isVisto: boolean }) {
  return (
    <span className={`default-apps-handler${props.isVisto ? " is-visto" : ""}`}>
      {props.isVisto && <CheckIcon size={12} />}
      {props.text}
    </span>
  );
}

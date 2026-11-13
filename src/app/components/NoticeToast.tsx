import { useShallow } from "zustand/react/shallow";
import { useLibraryStore } from "../../engine/stores";

/** The transient notice toast; clicking it (or its action) dismisses it. */
export function NoticeToast() {
  const library = useLibraryStore(
    useShallow((s) => ({
      notice: s.notice,
      noticeCode: s.noticeCode,
      noticeAction: s.noticeAction,
      showNotice: s.showNotice,
    })),
  );
  if (!library.notice) return null;
  return (
    <div
      className={`toast ${library.noticeCode ? "toast-warning" : ""}`}
      role={library.noticeCode ? "alert" : "status"}
      aria-live={library.noticeCode ? "assertive" : "polite"}
      onClick={() => library.showNotice("")}
    >
      <span aria-hidden="true">{library.noticeCode ? "!" : "✓"}</span>
      {library.notice}
      {library.noticeAction ? (
        <button
          type="button"
          className="toast-action"
          onClick={(event) => {
            event.stopPropagation();
            library.noticeAction?.run();
            library.showNotice("");
          }}
        >
          {library.noticeAction.label}
        </button>
      ) : null}
    </div>
  );
}

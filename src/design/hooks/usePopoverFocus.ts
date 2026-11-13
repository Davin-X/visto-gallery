import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Keyboard focus for a non-modal popover (a dropdown panel or a small menu):
 * - opening moves focus to its first control, so the keyboard can reach it;
 * - closing returns focus to the trigger, unless the user already clicked
 *   somewhere else;
 * - with `menu`, ArrowUp/ArrowDown/Home/End move between `role="menuitem"`s.
 */
export function usePopoverFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  { menu = false }: { menu?: boolean } = {},
) {
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      const frame = requestAnimationFrame(() => {
        const panel = panelRef.current;
        const first =
          panel?.querySelector<HTMLElement>("[data-autofocus]:not([disabled])") ??
          panel?.querySelector<HTMLElement>(menu ? "[role='menuitem']:not([disabled])" : FOCUSABLE);
        first?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      const active = document.activeElement;
      // Only take focus back when it would otherwise be lost.
      if (!active || active === document.body || panelRef.current?.contains(active)) {
        triggerRef.current?.focus();
      }
    }
  }, [open, panelRef, triggerRef, menu]);

  useEffect(() => {
    if (!open || !menu) return;
    const panel = panelRef.current;
    if (!panel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>("[role='menuitem']:not([disabled])"),
      );
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      let next = -1;
      if (event.key === "ArrowDown") next = index < items.length - 1 ? index + 1 : 0;
      else if (event.key === "ArrowUp") next = index > 0 ? index - 1 : items.length - 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = items.length - 1;
      if (next < 0) return;
      event.preventDefault();
      items[next].focus();
    };
    panel.addEventListener("keydown", onKeyDown);
    return () => panel.removeEventListener("keydown", onKeyDown);
  }, [open, menu, panelRef]);
}

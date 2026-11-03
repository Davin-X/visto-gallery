import { useEffect, useRef } from "react";

/**
 * Unified keyboard handler. Registers a single window `keydown` listener and
 * chains every handler in order. A handler that calls `e.preventDefault()`
 * stops the chain, so subsequent handlers don't fire for the same key.
 *
 * Use this instead of adding independent `window.addEventListener("keydown", …)`
 * listeners in multiple components, which can fire conflicting logic for the
 * same keypress.
 */
export function useKeyboard(handlers: Array<(e: KeyboardEvent) => void>) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      for (const handler of handlersRef.current) {
        handler(e);
        if (e.defaultPrevented) break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

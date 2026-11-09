import type { BackendProgressPhase } from "./types/commands";

/**
 * The phase a UI operation sets locally before the backend reports progress.
 * This is not the same vocabulary as `BackendProgressPhase`: an import is shown
 * as `importing`, but `importFiles` emits its progress as `scanning`.
 */
export type OperationPhase = "scanning" | "importing" | "hashing" | "trashing";

/**
 * Backend phases that belong to each running operation.
 *
 * Progress events are presentation-only, so an event may only update the
 * overlay while the operation that owns it is active. Matching on the phase
 * name alone silently dropped every import event (the UI says `importing`, the
 * backend says `scanning`), which froze the progress bar at 0.
 */
export const OPERATION_PHASES: Record<OperationPhase, readonly BackendProgressPhase[]> = {
  importing: ["scanning"],
  scanning: ["scanning"],
  hashing: ["hashing"],
  trashing: ["trashing"],
};

function isOperationPhase(phase: string): phase is OperationPhase {
  return Object.prototype.hasOwnProperty.call(OPERATION_PHASES, phase);
}

/**
 * Whether a progress event describes the operation currently holding the busy
 * overlay. With no active operation any event may take over the overlay; an
 * unknown operation phase falls back to an exact name match.
 */
export function progressBelongsToOperation(activePhase: string, eventPhase: string): boolean {
  if (!activePhase) return true;
  if (!isOperationPhase(activePhase)) return activePhase === eventPhase;
  return (OPERATION_PHASES[activePhase] as readonly string[]).includes(eventPhase);
}

import type { CommandError, ErrorCode } from "./generated/ipc";

/** The error a Tauri command rejects with: `{ code, message }`. */
export type { CommandError, ErrorCode };

/**
 * Stable code behind a rejected command, or `null` for anything else (web
 * preview, a thrown `Error`, a plain string).
 */
export function errorCode(error: unknown): ErrorCode | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code as ErrorCode;
  }
  return null;
}

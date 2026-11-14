import { create } from "zustand";
import { tauri } from "../commands/tauri";
import type { HiddenLockStatus } from "../types/commands";

/**
 * Touch ID / password lock for Hidden, mirrored from the backend, which is
 * the authority: it refuses hidden items and zeroes their counts while locked.
 */
interface HiddenLockState {
  /** `null` until the first answer, or when the backend has none (preview). */
  status: HiddenLockStatus | null;
  unlocking: boolean;
  refresh: () => Promise<HiddenLockStatus | null>;
  /** Ask for Touch ID or the password; resolves to whether Hidden is open. */
  unlock: () => Promise<boolean>;
  /** Called while Hidden is on screen; locks the view once the unlock expired. */
  keepAlive: () => Promise<void>;
  lock: () => Promise<void>;
}

function isStatus(value: unknown): value is HiddenLockStatus {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as HiddenLockStatus).required === "boolean" &&
    typeof (value as HiddenLockStatus).unlocked === "boolean"
  );
}

/** True when Hidden must not be shown until its owner unlocks it. */
export function isHiddenLocked(status: HiddenLockStatus | null): boolean {
  return !!status && status.required && !status.unlocked;
}

export const useHiddenLockStore = create<HiddenLockState>((set, get) => ({
  status: null,
  unlocking: false,

  refresh: async () => {
    try {
      const value: unknown = await tauri.hiddenLock.status();
      const status = isStatus(value) ? value : null;
      set({ status });
      return status;
    } catch {
      return get().status;
    }
  },

  unlock: async () => {
    if (get().unlocking) return false;
    set({ unlocking: true });
    try {
      const unlocked = await tauri.hiddenLock.unlock();
      await get().refresh();
      return unlocked === true;
    } catch {
      await get().refresh();
      return false;
    } finally {
      set({ unlocking: false });
    }
  },

  keepAlive: async () => {
    const status = get().status;
    if (!status?.required || !status.unlocked) return;
    try {
      const alive = await tauri.hiddenLock.keepAlive();
      if (alive === false) await get().refresh();
    } catch {
      await get().refresh();
    }
  },

  lock: async () => {
    try {
      await tauri.hiddenLock.lock();
    } finally {
      await get().refresh();
    }
  },
}));

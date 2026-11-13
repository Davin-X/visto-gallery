import { create } from "zustand";
import type { Screen } from "./screen";

/**
 * Which top-level screen is showing, plus the trail the sidebar's Back button
 * walks. Kept out of App so screens and hooks can navigate without having a
 * setter threaded through every layer.
 */
interface NavigationState {
  screen: Screen;
  history: Screen[];
  /** Replace the current screen without recording history. */
  setScreen: (screen: Screen) => void;
  /**
   * Navigate to `next`, recording `from` so Back can return to it. Passing
   * `from` explicitly keeps the caller's view of "where we were" even when
   * navigation is finished after an await.
   */
  pushScreen: (next: Screen, from: Screen) => void;
  /** Return to the most recently recorded screen, if any. */
  goBack: () => void;
}

export const useNavigationStore = create<NavigationState>()((set) => ({
  screen: "Library",
  history: [],
  setScreen: (screen) => set({ screen }),
  pushScreen: (next, from) =>
    set((state) => ({
      screen: next,
      history: next !== from ? [...state.history, from] : state.history,
    })),
  goBack: () =>
    set((state) => {
      if (state.history.length === 0) return state;
      return {
        screen: state.history[state.history.length - 1],
        history: state.history.slice(0, -1),
      };
    }),
}));

/** Stable setter for code outside React render (event handlers, hooks). */
export const setScreen = (screen: Screen) => useNavigationStore.getState().setScreen(screen);

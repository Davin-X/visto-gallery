import { create } from "zustand";
import { useLibraryStore } from "../engine/stores";
import type { Screen } from "./screen";

/** Where the user is: a screen, plus the album open on it (if any). */
export interface NavLocation {
  screen: Screen;
  album: string | null;
}

/**
 * Screens that are not steps of their own in Back/Forward: the photo viewer
 * and the video player have their own back arrows, and returning to a closed
 * player would only reopen whatever was last shown.
 */
const TRANSIENT: ReadonlySet<Screen> = new Set<Screen>(["Viewer", "Video"]);

/** Back keeps the last this-many locations. */
export const HISTORY_LIMIT = 50;

const sameLocation = (a: NavLocation, b: NavLocation) =>
  a.screen === b.screen && a.album === b.album;

const activeAlbum = () => useLibraryStore.getState().activeAlbum ?? null;

/** Make the library show `location`'s album before its screen appears. */
function applyAlbum(location: NavLocation) {
  const library = useLibraryStore.getState();
  if ((library.activeAlbum ?? null) !== location.album) {
    library.setActiveAlbum(location.album);
  }
}

/**
 * Which screen is showing, and the trail Back and Forward walk. Every screen
 * change goes through `setScreen`, so opening an album, a photo, Edit or a
 * player is recorded the same way as a sidebar click.
 */
/** The two views behind the single Clean up sidebar entry. */
export type CleanupScreen = "Duplicates" | "Cleanup";

/** Only the two Clean up screens change the remembered tab. */
const cleanupTabFor = (screen: Screen, current: CleanupScreen): CleanupScreen =>
  screen === "Duplicates" ? "Duplicates" : screen === "Cleanup" ? "Cleanup" : current;

interface NavigationState {
  screen: Screen;
  /** Which Clean up tab the sidebar entry returns to. */
  cleanupTab: CleanupScreen;
  /** Album of the current location, as of the last navigation. */
  album: string | null;
  history: NavLocation[];
  forward: NavLocation[];
  /**
   * Go to `screen`, recording where the user was. Callers that open an album
   * set it on the library store first; the new location picks it up.
   */
  setScreen: (screen: Screen) => void;
  /** Show `screen` without recording a step (startup, restoring state). */
  replaceScreen: (screen: Screen) => void;
  goBack: () => void;
  goForward: () => void;
}

export const useNavigationStore = create<NavigationState>()((set, get) => ({
  screen: "Library",
  cleanupTab: "Duplicates",
  album: null,
  history: [],
  forward: [],
  setScreen: (screen) => {
    const state = get();
    const from: NavLocation = { screen: state.screen, album: state.album };
    const to: NavLocation = { screen, album: activeAlbum() };
    if (sameLocation(from, to)) {
      set({ screen, album: to.album, cleanupTab: cleanupTabFor(screen, state.cleanupTab) });
      return;
    }
    const record = !TRANSIENT.has(from.screen);
    const last = state.history[state.history.length - 1];
    const history =
      record && !(last && sameLocation(last, from))
        ? [...state.history, from].slice(-HISTORY_LIMIT)
        : state.history;
    set({
      screen,
      album: to.album,
      history,
      forward: [],
      cleanupTab: cleanupTabFor(screen, state.cleanupTab),
    });
  },
  replaceScreen: (screen) =>
    set({
      screen,
      album: activeAlbum(),
      cleanupTab: cleanupTabFor(screen, get().cleanupTab),
    }),
  goBack: () => {
    const state = get();
    const target = state.history[state.history.length - 1];
    if (!target) return;
    const current: NavLocation = { screen: state.screen, album: state.album };
    applyAlbum(target);
    set({
      screen: target.screen,
      album: target.album,
      cleanupTab: cleanupTabFor(target.screen, state.cleanupTab),
      history: state.history.slice(0, -1),
      forward: TRANSIENT.has(current.screen) ? state.forward : [...state.forward, current],
    });
  },
  goForward: () => {
    const state = get();
    const target = state.forward[state.forward.length - 1];
    if (!target) return;
    const current: NavLocation = { screen: state.screen, album: state.album };
    applyAlbum(target);
    set({
      screen: target.screen,
      album: target.album,
      cleanupTab: cleanupTabFor(target.screen, state.cleanupTab),
      forward: state.forward.slice(0, -1),
      history: TRANSIENT.has(current.screen)
        ? state.history
        : [...state.history, current].slice(-HISTORY_LIMIT),
    });
  },
}));

/** Stable setter for code outside React render (event handlers, hooks). */
export const setScreen = (screen: Screen) => useNavigationStore.getState().setScreen(screen);

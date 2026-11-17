/// <reference types="vitest/globals" />
import { beforeEach, expect, test, vi } from "vitest";

// The store resolves the track through the asset protocol; a fake keeps the
// assertion explicit and independent of Tauri internals.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

// jsdom does not implement HTMLMediaElement; a fake element records what the
// store does to the ambient <audio> without touching the network.
const instances: FakeAudio[] = [];
class FakeAudio {
  src = "";
  dataset: Record<string, string> = {};
  muted = false;
  volume = 1;
  loop = false;
  preload = "";
  paused = true;
  private listeners: Record<string, () => void> = {};
  constructor() {
    instances.push(this);
  }
  addEventListener(type: string, cb: () => void) {
    this.listeners[type] = cb;
  }
  removeEventListener(type: string) {
    delete this.listeners[type];
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  load() {}
  pause() {
    this.paused = true;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  emitError() {
    this.listeners.error?.();
  }
}

import { useSlideshowStore } from "./useSlideshowStore";

beforeEach(() => {
  vi.stubGlobal("Audio", FakeAudio);
  instances.length = 0;
  // Make sure no ambient element survives from a previous test.
  useSlideshowStore.getState().setAmbientPath(null);
  useSlideshowStore.setState({ ambientError: false });
});

test("the ambient track loads through the asset protocol, not a raw path", () => {
  useSlideshowStore.getState().setAmbientPath("/music/track.mp3");
  expect(instances).toHaveLength(1);
  expect(instances[0].src).toBe("asset://localhost//music/track.mp3");
});

test("changing the volume or mute does not restart the track", () => {
  const store = useSlideshowStore.getState();
  store.setAmbientPath("/music/track.mp3");
  const audio = instances[0];
  const src = audio.src;
  store.setAmbientVolume(0.2);
  store.setAmbientMuted(true);
  // The src must not be reassigned on a volume/mute tweak.
  expect(audio.src).toBe(src);
  expect(audio.volume).toBe(0.2);
  expect(audio.muted).toBe(true);
});

test("a track that fails to load surfaces an error and keeps the path", () => {
  const store = useSlideshowStore.getState();
  store.setAmbientPath("/music/track.mp3");
  instances[0].emitError();
  const state = useSlideshowStore.getState();
  expect(state.ambientError).toBe(true);
  expect(state.ambientPath).toBe("/music/track.mp3");
});

test("closing the show releases the audio element", () => {
  const store = useSlideshowStore.getState();
  store.setAmbientPath("/music/track.mp3");
  const audio = instances[0];
  store.close();
  expect(audio.src).toBe("");
  expect(audio.paused).toBe(true);
});

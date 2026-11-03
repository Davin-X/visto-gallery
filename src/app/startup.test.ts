/// <reference types="vitest/globals" />
import { describe, expect, test } from "vitest";
import { shouldCheckForUpdatesOnLaunch } from "./startup";

describe("launch update preference", () => {
  test("is off unless the user explicitly opted in", () => {
    expect(shouldCheckForUpdatesOnLaunch({})).toBe(false);
    expect(shouldCheckForUpdatesOnLaunch({ checkForUpdatesOnLaunch: false })).toBe(false);
    expect(shouldCheckForUpdatesOnLaunch({ checkForUpdatesOnLaunch: true })).toBe(true);
  });
});

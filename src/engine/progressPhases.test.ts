import { describe, expect, test } from "vitest";
import { progressBelongsToOperation } from "./progressPhases";

describe("progressBelongsToOperation", () => {
  test("an idle overlay accepts any progress event", () => {
    expect(progressBelongsToOperation("", "scanning")).toBe(true);
  });

  test("an import keeps its progress even though the backend calls it scanning", () => {
    expect(progressBelongsToOperation("importing", "scanning")).toBe(true);
  });

  test("a trash operation ignores a background scan", () => {
    expect(progressBelongsToOperation("trashing", "scanning")).toBe(false);
    expect(progressBelongsToOperation("trashing", "trashing")).toBe(true);
  });

  test("a duplicate scan ignores a background scan", () => {
    expect(progressBelongsToOperation("hashing", "scanning")).toBe(false);
    expect(progressBelongsToOperation("hashing", "hashing")).toBe(true);
  });

  test("a library scan still accepts its own events", () => {
    expect(progressBelongsToOperation("scanning", "scanning")).toBe(true);
  });

  test("an unknown operation phase falls back to an exact match", () => {
    expect(progressBelongsToOperation("exporting", "exporting")).toBe(true);
    expect(progressBelongsToOperation("exporting", "scanning")).toBe(false);
  });
});

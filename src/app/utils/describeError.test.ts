/// <reference types="vitest/globals" />
import { describeError } from "./describeError";

describe("describeError", () => {
  test("returns string errors as-is", () => {
    expect(describeError("plain failure")).toBe("plain failure");
  });

  test("returns Error.message for Error instances", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  test("stringifies plain objects", () => {
    expect(describeError({ code: "E_FAIL", detail: 1 })).toBe(
      '{"code":"E_FAIL","detail":1}',
    );
  });

  test("falls back to String() when JSON serialization fails", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(describeError(circular)).toBe("[object Object]");
  });

  test("handles null and undefined", () => {
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBeUndefined();
  });
});

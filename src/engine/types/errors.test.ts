/// <reference types="vitest/globals" />
import { errorCode } from "./errors";

describe("errorCode", () => {
  test("returns the code from a serialized command error", () => {
    expect(errorCode({ code: "pathNotAllowed", message: "nope" })).toBe("pathNotAllowed");
  });

  test("returns null for errors without a code", () => {
    expect(errorCode(new Error("boom"))).toBeNull();
    expect(errorCode("plain string")).toBeNull();
    expect(errorCode(null)).toBeNull();
    expect(errorCode({ message: "no code" })).toBeNull();
  });

  test("returns null when code is not a string", () => {
    expect(errorCode({ code: 42 })).toBeNull();
  });
});

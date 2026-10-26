/// <reference types="vitest/globals" />
import {
  getTypeIdentity,
  getKindBadgeClass,
  getKindDotClass,
} from "./mediaTypes";

test("media types", () => {
  expect(getTypeIdentity("photo").label).toBe("Photo");
  expect(getKindBadgeClass("video")).toBe("kind-badge video");
  expect(getKindDotClass("raw")).toBe("kind-dot raw");
});

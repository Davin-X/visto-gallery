/// <reference types="vitest/globals" />
import { libraryHeading } from "./LibraryScreen";

test("a Smart Album keeps its own name instead of reading All Media", () => {
  // Rating, tag and colour definitions do not map onto a TYPE tab, so the
  // saved name is the only heading that explains the filtered grid.
  expect(libraryHeading(false, "Five Stars", "All")).toBe("Five Stars");
  expect(libraryHeading(false, "Dark & Minimal", "All")).toBe("Dark & Minimal");
  expect(libraryHeading(false, "Blue - Space", "All")).toBe("Blue - Space");
});

test("kind-based collections still use their tab name", () => {
  expect(libraryHeading(false, null, "All")).toBe("All Media");
  expect(libraryHeading(false, null, "Photos")).toBe("Photos");
  expect(libraryHeading(false, null, "Videos")).toBe("Videos");
  expect(libraryHeading(false, null, "RAW")).toBe("RAW");
  expect(libraryHeading(false, null, "Animations")).toBe("Animations");
  expect(libraryHeading(false, null, "Favorites")).toBe("Favorites");
});

test("the hidden gallery never borrows a smart album name", () => {
  expect(libraryHeading(true, "Five Stars", "Photos")).toBe("Hidden");
});

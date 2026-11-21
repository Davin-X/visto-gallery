import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  SmartAlbumDialog,
  editableFrom,
  filterFrom,
  parseTags,
  type Editable,
} from "./SmartAlbumDialog";

const richFilter = {
  kind: "video" as const,
  favorite: true,
  rating: 3,
  query: "sunset",
  dateFrom: Date.UTC(2026, 0, 1),
  dateTo: Date.UTC(2026, 0, 31),
  // Clauses the dialog does not show: they must survive an edit untouched.
  camera: "X100V",
  lens: "23mm",
  colorLabel: "blue",
  sourcePath: "/Volumes/Photos",
  sortBy: "name" as const,
  sortOrder: "desc" as const,
};

const blankDraft: Editable = {
  kind: undefined,
  favorite: false,
  rating: null,
  query: "",
  tags: "",
  tagMatch: "any",
  sizeMinMb: null,
  sizeMaxMb: null,
  extension: "",
  animated: null,
  hasLocation: null,
  orientation: undefined,
  dateFrom: null,
  dateTo: null,
};

const BYTES_IN_MB = 1024 * 1024;

test("editableFrom reads the fields the dialog edits and defaults the rest", () => {
  expect(editableFrom(richFilter)).toEqual({
    kind: "video",
    favorite: true,
    rating: 3,
    query: "sunset",
    tags: "",
    tagMatch: "any",
    sizeMinMb: null,
    sizeMaxMb: null,
    extension: "",
    animated: null,
    hasLocation: null,
    orientation: undefined,
    dateFrom: Date.UTC(2026, 0, 1),
    dateTo: Date.UTC(2026, 0, 31),
  });

  expect(editableFrom({})).toEqual(blankDraft);
});

test("filterFrom keeps clauses the dialog cannot show", () => {
  const result = filterFrom(richFilter, editableFrom(richFilter));

  expect(result).toEqual(richFilter);
});

test("filterFrom replaces the exposed fields and clears what was emptied", () => {
  const result = filterFrom(richFilter, {
    ...blankDraft,
    kind: "photo",
    query: "   ",
    tags: "beach, family",
  });

  expect(result.kind).toBe("photo");
  // Empty means absent, not a clause that matches nothing.
  expect(result.favorite).toBeUndefined();
  expect(result.rating).toBeUndefined();
  expect(result.query).toBeUndefined();
  expect(result.dateFrom).toBeUndefined();
  expect(result.dateTo).toBeUndefined();
  expect(result.tags).toEqual(["beach", "family"]);
  // Untouched clauses are still carried through.
  expect(result.camera).toBe("X100V");
  expect(result.sortBy).toBe("name");
  expect(result.sortOrder).toBe("desc");
});

test("filterFrom writes the v2 clauses, normalising what it stores", () => {
  const result = filterFrom(
    {},
    {
      ...blankDraft,
      tags: " beach, family, beach ",
      tagMatch: "all",
      sizeMinMb: 1.5,
      sizeMaxMb: 10,
      extension: ".JPG",
      animated: true,
      hasLocation: true,
      orientation: "landscape",
    },
  );

  expect(result.tags).toEqual(["beach", "family"]);
  expect(result.tagMatch).toBe("all");
  expect(result.sizeMin).toBe(Math.round(1.5 * BYTES_IN_MB));
  expect(result.sizeMax).toBe(10 * BYTES_IN_MB);
  expect(result.extension).toBe("jpg");
  expect(result.animated).toBe(true);
  expect(result.hasLocation).toBe(true);
  expect(result.orientation).toBe("landscape");
});

test("filterFrom preserves an album that excludes located items", () => {
  const definition = { kind: "photo" as const, hasLocation: false };

  const result = filterFrom(definition, editableFrom(definition));

  expect(result.hasLocation).toBe(false);
  expect(editableFrom(definition).hasLocation).toBe(false);
});

test("the No location chip shows and submits an explicit exclusion", async () => {
  const onSubmit = vi.fn().mockResolvedValue(true);

  render(
    <SmartAlbumDialog
      mode="edit"
      initialName="Unmapped"
      initialFilter={{ hasLocation: false }}
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />,
  );

  expect(screen.getByRole("button", { name: "No location" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  });

  expect(onSubmit).toHaveBeenCalledWith("Unmapped", { hasLocation: false });
});

test("a negative size is reported instead of silently becoming unset", async () => {
  const onSubmit = vi.fn().mockResolvedValue(true);

  render(
    <SmartAlbumDialog
      mode="create"
      initialName="No negatives"
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />,
  );

  fireEvent.change(screen.getByLabelText("Minimum size in megabytes"), {
    target: { value: "-5" },
  });

  expect(screen.getByRole("alert")).toHaveTextContent(/file size cannot be negative/i);
  expect(screen.getByRole("button", { name: "Create Smart Album" })).toBeDisabled();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("filterFrom drops tag matching that would not change anything", () => {
  expect(
    filterFrom({}, { ...blankDraft, tags: "beach", tagMatch: "all" }).tagMatch,
  ).toBeUndefined();
  expect(filterFrom({}, { ...blankDraft, tags: "", tagMatch: "all" }).tagMatch).toBeUndefined();
});

test("filterFrom trims the text clause and drops an empty favorite flag", () => {
  const result = filterFrom(
    { favorite: true },
    {
      ...blankDraft,
      query: "  sunset  ",
    },
  );

  expect(result.query).toBe("sunset");
  expect(result.favorite).toBeUndefined();
});

test("edit mode starts from the saved definition and submits it merged", async () => {
  const onSubmit = vi.fn().mockResolvedValue(true);
  const onClose = vi.fn();

  render(
    <SmartAlbumDialog
      mode="edit"
      initialName="Volumes"
      initialFilter={richFilter}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );

  expect(screen.getByRole("heading", { name: "Edit Smart Album" })).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toHaveValue("Volumes");
  expect(screen.getByRole("button", { name: "Videos" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Favorites" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "3 stars and up" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByLabelText("Contains text")).toHaveValue("sunset");

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Night walks" } });
  fireEvent.click(screen.getByRole("button", { name: "4 stars and up" }));

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  });

  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit.mock.calls[0][0]).toBe("Night walks");
  expect(onSubmit.mock.calls[0][1]).toEqual({
    ...richFilter,
    rating: 4,
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("the v2 controls collect tags, size, extension, animation, location and shape", async () => {
  const onSubmit = vi.fn().mockResolvedValue(true);

  render(
    <SmartAlbumDialog
      mode="create"
      initialName="Big trips"
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />,
  );

  fireEvent.change(screen.getByLabelText("Tags"), {
    target: { value: "beach, family" },
  });
  fireEvent.click(screen.getByRole("button", { name: "All tags" }));
  fireEvent.change(screen.getByLabelText("Minimum size in megabytes"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("Maximum size in megabytes"), {
    target: { value: "20" },
  });
  fireEvent.change(screen.getByLabelText("File extension"), {
    target: { value: ".jpg" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Animated" }));
  fireEvent.click(screen.getByRole("button", { name: "Has location" }));
  fireEvent.click(screen.getByRole("button", { name: "Landscape" }));

  expect(screen.getByLabelText("Tags")).toHaveValue("beach, family");
  expect(screen.getByRole("button", { name: "All tags" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Animated" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Has location" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Landscape" })).toHaveAttribute("aria-pressed", "true");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create Smart Album" }));
  });

  expect(onSubmit).toHaveBeenCalledWith("Big trips", {
    tags: ["beach", "family"],
    tagMatch: "all",
    sizeMin: 2 * BYTES_IN_MB,
    sizeMax: 20 * BYTES_IN_MB,
    extension: "jpg",
    animated: true,
    hasLocation: true,
    orientation: "landscape",
  });
});

test("animation chips toggle back to any", () => {
  const onSubmit = vi.fn().mockResolvedValue(true);

  render(
    <SmartAlbumDialog
      mode="create"
      initialName="Anything animated"
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Stills" }));
  expect(screen.getByRole("button", { name: "Stills" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Stills" }));
  expect(screen.getByRole("button", { name: "Stills" })).toHaveAttribute("aria-pressed", "false");
});

test("refuses an inverted size range instead of sending it to the backend", async () => {
  const onSubmit = vi.fn().mockResolvedValue(true);

  render(
    <SmartAlbumDialog
      mode="create"
      initialName="Too specific"
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />,
  );

  fireEvent.change(screen.getByLabelText("Minimum size in megabytes"), {
    target: { value: "20" },
  });
  fireEvent.change(screen.getByLabelText("Maximum size in megabytes"), {
    target: { value: "2" },
  });

  expect(screen.getByRole("alert")).toHaveTextContent(/minimum size cannot be larger/i);
  expect(screen.getByRole("button", { name: "Create Smart Album" })).toBeDisabled();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("create mode starts blank and refuses to submit without a name", async () => {
  const onSubmit = vi.fn().mockResolvedValue(true);

  render(<SmartAlbumDialog mode="create" onSubmit={onSubmit} onClose={vi.fn()} />);

  expect(screen.getByRole("heading", { name: "New Smart Album" })).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Create Smart Album" })).toBeDisabled();

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
  expect(screen.getByRole("button", { name: "Create Smart Album" })).toBeDisabled();

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Favourites " } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create Smart Album" }));
  });

  expect(onSubmit).toHaveBeenCalledWith("Favourites", {});
});

test("a failed save keeps the dialog open with the definition intact", async () => {
  const onSubmit = vi.fn().mockResolvedValue(false);
  const onClose = vi.fn();

  render(
    <SmartAlbumDialog
      mode="create"
      initialName="Holidays"
      initialFilter={{ kind: "raw" }}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create Smart Album" }));
  });

  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(/already in use/i);
  expect(screen.getByLabelText("Name")).toHaveValue("Holidays");
  expect(screen.getByRole("button", { name: "RAW" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Create Smart Album" })).toBeEnabled();
});

test("Escape closes the dialog", () => {
  const onClose = vi.fn();
  render(<SmartAlbumDialog mode="create" onSubmit={vi.fn()} onClose={onClose} />);

  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("parseTags keeps one spelling of each tag, ignoring case", () => {
  expect(parseTags(" Beach, beach ,family,, BEACH ")).toEqual(["Beach", "family"]);
});

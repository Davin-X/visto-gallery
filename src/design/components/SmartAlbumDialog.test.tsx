import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SmartAlbumDialog, editableFrom, filterFrom } from "./SmartAlbumDialog";

const richFilter = {
  kind: "video" as const,
  favorite: true,
  rating: 3,
  query: "sunset",
  dateFrom: Date.UTC(2026, 0, 1),
  dateTo: Date.UTC(2026, 0, 31),
  // Clauses the dialog does not show: they must survive an edit untouched.
  tags: ["beach", "family"],
  camera: "X100V",
  lens: "23mm",
  colorLabel: "blue",
  sourcePath: "/Volumes/Photos",
  sortBy: "name" as const,
  sortOrder: "desc" as const,
};

test("editableFrom reads the fields the dialog edits and defaults the rest", () => {
  expect(editableFrom(richFilter)).toEqual({
    kind: "video",
    favorite: true,
    rating: 3,
    query: "sunset",
    dateFrom: Date.UTC(2026, 0, 1),
    dateTo: Date.UTC(2026, 0, 31),
  });

  expect(editableFrom({})).toEqual({
    kind: undefined,
    favorite: false,
    rating: null,
    query: "",
    dateFrom: null,
    dateTo: null,
  });
});

test("filterFrom keeps clauses the dialog cannot show", () => {
  const result = filterFrom(richFilter, editableFrom(richFilter));

  expect(result).toEqual(richFilter);
});

test("filterFrom replaces the exposed fields and clears what was emptied", () => {
  const result = filterFrom(richFilter, {
    kind: "photo",
    favorite: false,
    rating: null,
    query: "   ",
    dateFrom: null,
    dateTo: null,
  });

  expect(result.kind).toBe("photo");
  // Empty means absent, not a clause that matches nothing.
  expect(result.favorite).toBeUndefined();
  expect(result.rating).toBeUndefined();
  expect(result.query).toBeUndefined();
  expect(result.dateFrom).toBeUndefined();
  expect(result.dateTo).toBeUndefined();
  // Untouched clauses are still carried through.
  expect(result.tags).toEqual(["beach", "family"]);
  expect(result.camera).toBe("X100V");
  expect(result.sortBy).toBe("name");
  expect(result.sortOrder).toBe("desc");
});

test("filterFrom trims the text clause and drops an empty favorite flag", () => {
  const result = filterFrom(
    { favorite: true },
    {
      kind: undefined,
      favorite: false,
      rating: null,
      query: "  sunset  ",
      dateFrom: null,
      dateTo: null,
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

import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FilterDropdown } from "./FilterDropdown";

test("opens filter controls outside the horizontally scrolling row", () => {
  const onSetMinRating = vi.fn();

  render(
    <div className="app-frame">
      <div style={{ overflowX: "auto" }}>
        <FilterDropdown
          minRating={null}
          colorLabelFilter={null}
          dateFrom={null}
          dateTo={null}
          tags={[]}
          tagsFilter={[]}
          onSetMinRating={onSetMinRating}
          onSetColorLabelFilter={vi.fn()}
          onSetTagsFilter={vi.fn()}
          onSetDateRange={vi.fn()}
        />
      </div>
    </div>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Filters" }));

  const panel = document.querySelector(".filter-dropdown-panel");
  expect(panel).toBeInTheDocument();
  expect(panel?.parentElement).toHaveClass("app-frame");
  expect(
    within(panel as HTMLElement).getByRole("heading", {
      name: "Refine your view",
    }),
  ).toBeInTheDocument();
  expect(within(panel as HTMLElement).getByText("Rating")).toBeInTheDocument();
  expect(within(panel as HTMLElement).getByText("Color label")).toBeInTheDocument();
  expect(within(panel as HTMLElement).queryByPlaceholderText("Camera model")).toBeNull();
  expect(within(panel as HTMLElement).queryByPlaceholderText("Lens model")).toBeNull();

  fireEvent.click(
    within(panel as HTMLElement).getByRole("button", {
      name: "3 stars and up",
    }),
  );
  expect(onSetMinRating).toHaveBeenCalledWith(3);
});

test("clears every active filter from the dropdown", () => {
  const onSetMinRating = vi.fn();
  const onSetColorLabelFilter = vi.fn();
  const onSetTagsFilter = vi.fn();
  const onSetDateRange = vi.fn();

  render(
    <div className="app-frame">
      <FilterDropdown
        minRating={4}
        colorLabelFilter="blue"
        dateFrom={Date.UTC(2024, 0, 1)}
        dateTo={Date.UTC(2024, 0, 31)}
        tags={[{ id: "t1", name: "space", colorIndex: 0, createdAt: 1, itemCount: 86 }]}
        tagsFilter={["space"]}
        onSetMinRating={onSetMinRating}
        onSetColorLabelFilter={onSetColorLabelFilter}
        onSetTagsFilter={onSetTagsFilter}
        onSetDateRange={onSetDateRange}
      />
    </div>,
  );

  fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
  fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

  expect(onSetMinRating).toHaveBeenCalledWith(null);
  expect(onSetColorLabelFilter).toHaveBeenCalledWith(null);
  expect(onSetTagsFilter).toHaveBeenCalledWith([]);
  expect(onSetDateRange).toHaveBeenCalledWith(null, null);
});

test("adds capture dates and saves the current filters as a Smart Album", () => {
  const onSetDateRange = vi.fn();
  const onCreateSmartAlbum = vi.fn();

  render(
    <div className="app-frame">
      <FilterDropdown
        minRating={null}
        colorLabelFilter={null}
        dateFrom={null}
        dateTo={null}
        tags={[]}
        tagsFilter={[]}
        onSetMinRating={vi.fn()}
        onSetColorLabelFilter={vi.fn()}
        onSetTagsFilter={vi.fn()}
        onSetDateRange={onSetDateRange}
        onCreateSmartAlbum={onCreateSmartAlbum}
      />
    </div>,
  );

  fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
  const panel = document.querySelector(".filter-dropdown-panel") as HTMLElement;
  expect(within(panel).getByText("Capture date")).toBeInTheDocument();

  fireEvent.change(within(panel).getByLabelText("From"), {
    target: { value: "2024-03-15" },
  });
  expect(onSetDateRange).toHaveBeenCalledWith(new Date(2024, 2, 15, 0, 0, 0, 0).getTime(), null);

  fireEvent.change(within(panel).getByLabelText("Smart Album name"), {
    target: { value: "Spring 2024" },
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
  expect(onCreateSmartAlbum).toHaveBeenCalledWith("Spring 2024");
});

test("tag chips are a quiet multi-select that reaches the page filter", () => {
  const onSetTagsFilter = vi.fn();

  render(
    <div className="app-frame">
      <FilterDropdown
        minRating={null}
        colorLabelFilter={null}
        dateFrom={null}
        dateTo={null}
        tags={[
          { id: "t1", name: "space", colorIndex: 0, createdAt: 1, itemCount: 86 },
          { id: "t2", name: "minimal", colorIndex: 0, createdAt: 1, itemCount: 17 },
        ]}
        tagsFilter={["space"]}
        onSetMinRating={vi.fn()}
        onSetColorLabelFilter={vi.fn()}
        onSetTagsFilter={onSetTagsFilter}
        onSetDateRange={vi.fn()}
      />
    </div>,
  );

  fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
  const panel = document.querySelector(".filter-dropdown-panel") as HTMLElement;

  const space = within(panel).getByRole("button", { name: "space, 86 items" });
  expect(space).toHaveAttribute("aria-pressed", "true");
  expect(within(panel).getByText("1 SELECTED")).toBeInTheDocument();

  fireEvent.click(space);
  expect(onSetTagsFilter).toHaveBeenLastCalledWith([]);

  fireEvent.click(within(panel).getByRole("button", { name: "minimal, 17 items" }));
  expect(onSetTagsFilter).toHaveBeenLastCalledWith(["space", "minimal"]);
});

test("no tag section is shown when the library has no tags", () => {
  render(
    <div className="app-frame">
      <FilterDropdown
        minRating={null}
        colorLabelFilter={null}
        dateFrom={null}
        dateTo={null}
        tags={[]}
        tagsFilter={[]}
        onSetMinRating={vi.fn()}
        onSetColorLabelFilter={vi.fn()}
        onSetTagsFilter={vi.fn()}
        onSetDateRange={vi.fn()}
      />
    </div>,
  );

  fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
  const panel = document.querySelector(".filter-dropdown-panel") as HTMLElement;
  expect(within(panel).queryByText("Tags")).toBeNull();
});

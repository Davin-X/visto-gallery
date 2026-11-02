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
          onSetMinRating={onSetMinRating}
          onSetColorLabelFilter={vi.fn()}
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

  render(
    <div className="app-frame">
      <FilterDropdown
        minRating={4}
        colorLabelFilter="blue"
        onSetMinRating={onSetMinRating}
        onSetColorLabelFilter={onSetColorLabelFilter}
      />
    </div>,
  );

  fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
  fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

  expect(onSetMinRating).toHaveBeenCalledWith(null);
  expect(onSetColorLabelFilter).toHaveBeenCalledWith(null);
});

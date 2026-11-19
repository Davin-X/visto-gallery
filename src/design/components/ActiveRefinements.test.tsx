/// <reference types="vitest/globals" />
import { fireEvent, render, screen } from "@testing-library/react";
import { ActiveRefinements, type ActiveRefinementsProps } from "./ActiveRefinements";

function props(overrides: Partial<ActiveRefinementsProps> = {}): ActiveRefinementsProps {
  return {
    tags: [],
    minRating: null,
    colorLabel: null,
    camera: null,
    lens: null,
    dateLabel: "",
    onRemoveTag: vi.fn(),
    onClearRating: vi.fn(),
    onClearColor: vi.fn(),
    onClearCamera: vi.fn(),
    onClearLens: vi.fn(),
    onClearDate: vi.fn(),
    ...overrides,
  };
}

test("renders nothing when no refinement is active", () => {
  const { container } = render(<ActiveRefinements {...props()} />);

  expect(container).toBeEmptyDOMElement();
});

test("gives every refinement its own removable chip", () => {
  const onRemoveTag = vi.fn();
  const onClearRating = vi.fn();
  const onClearColor = vi.fn();
  const onClearCamera = vi.fn();
  const onClearLens = vi.fn();
  const onClearDate = vi.fn();

  render(
    <ActiveRefinements
      {...props({
        tags: ["space", "minimal"],
        minRating: 4,
        colorLabel: "blue",
        camera: "Nikon Z8",
        lens: "Nikkor Z 50mm",
        dateLabel: "2024-01-01 – 2024-01-31",
        onRemoveTag,
        onClearRating,
        onClearColor,
        onClearCamera,
        onClearLens,
        onClearDate,
      })}
    />,
  );

  for (const name of [
    "Remove tag filter space",
    "Remove tag filter minimal",
    "Remove rating filter: 4 stars and up",
    "Remove blue colour filter",
    "Remove camera filter Nikon Z8",
    "Remove lens filter Nikkor Z 50mm",
    "Remove date filter 2024-01-01 – 2024-01-31",
  ]) {
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
  }

  fireEvent.click(screen.getByRole("button", { name: "Remove tag filter space" }));
  expect(onRemoveTag).toHaveBeenCalledWith("space");

  fireEvent.click(screen.getByRole("button", { name: "Remove rating filter: 4 stars and up" }));
  expect(onClearRating).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Remove blue colour filter" }));
  expect(onClearColor).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Remove camera filter Nikon Z8" }));
  expect(onClearCamera).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Remove lens filter Nikkor Z 50mm" }));
  expect(onClearLens).toHaveBeenCalledTimes(1);

  fireEvent.click(
    screen.getByRole("button", { name: "Remove date filter 2024-01-01 – 2024-01-31" }),
  );
  expect(onClearDate).toHaveBeenCalledTimes(1);
});

test("labels each chip with the value being removed", () => {
  render(<ActiveRefinements {...props({ tags: ["nature"], colorLabel: "green" })} />);

  expect(screen.getByText("#nature")).toBeInTheDocument();
  expect(screen.getByText("Green")).toBeInTheDocument();
  // The × is decorative; the accessible name is the sentence on the button.
  expect(screen.getAllByText("×")).toHaveLength(2);
});

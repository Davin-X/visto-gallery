import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SplitButton from "./SplitButton";
import { PlusIcon, FolderIcon } from "./icons";

describe("split button", () => {
  it("invokes the primary action directly", () => {
    const onPrimary = vi.fn();
    render(
      <SplitButton
        label="Add folder"
        icon={FolderIcon}
        onClick={onPrimary}
        menuLabel="More import options"
        items={[{ key: "files", label: "Add files…", icon: PlusIcon, onClick: vi.fn() }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    expect(onPrimary).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the menu from the chevron and runs the secondary action", () => {
    const onSecondary = vi.fn();
    render(
      <div className="app-frame">
        <SplitButton
          label="Add folder"
          icon={FolderIcon}
          onClick={vi.fn()}
          menuLabel="More import options"
          items={[{ key: "files", label: "Add files…", icon: PlusIcon, onClick: onSecondary }]}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "More import options" }));
    const menu = document.querySelector(".split-button-panel") as HTMLElement;
    expect(menu).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Add files…" }));
    expect(onSecondary).toHaveBeenCalledOnce();
    expect(document.querySelector(".split-button-panel")).toBeNull();
  });

  it("closes the menu on Escape without running any action", () => {
    const onSecondary = vi.fn();
    render(
      <SplitButton
        label="Add folder"
        icon={FolderIcon}
        onClick={vi.fn()}
        menuLabel="More import options"
        items={[{ key: "files", label: "Add files…", icon: PlusIcon, onClick: onSecondary }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "More import options" }));
    expect(document.querySelector(".split-button-panel")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector(".split-button-panel")).toBeNull();
    expect(onSecondary).not.toHaveBeenCalled();
  });
});

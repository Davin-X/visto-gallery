/// <reference types="vitest/globals" />
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi, beforeEach } from "vitest";
import type { DefaultAppType, DefaultAppsStatus } from "../../../engine/types/commands";

const mocks = vi.hoisted(() => ({ status: vi.fn(), set: vi.fn() }));

vi.mock("../../../engine/commands/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../engine/commands/tauri")>();
  return { ...actual, tauri: { defaultApps: { status: mocks.status, set: mocks.set } } };
});

import { DefaultAppsSection, groupStatus, listLabels, runNotice } from "./DefaultAppsSection";

function type(
  uti: string,
  label: string,
  group: DefaultAppType["group"],
  isVisto = false,
  handlerName: string | null = isVisto ? "VistoGallery" : "Preview",
): DefaultAppType {
  return { uti, label, group, isVisto, handlerName };
}

function status(types: DefaultAppType[], supported = true): DefaultAppsStatus {
  return {
    supported,
    unsupportedReason: supported ? null : "Default apps can be set from the installed app.",
    types,
  };
}

const photos = [
  type("public.jpeg", "JPEG", "photos"),
  type("public.png", "PNG", "photos", true),
  type("public.heic", "HEIC", "photos"),
];
const videos = [
  type("public.mpeg-4", "MP4", "videos", true),
  type("com.apple.quicktime-movie", "MOV", "videos", true),
];
const gif = type("com.compuserve.gif", "GIF", "other");

beforeEach(() => {
  mocks.status.mockReset();
  mocks.set.mockReset();
});

describe("helpers", () => {
  test("lists labels the way a sentence would", () => {
    expect(listLabels([])).toBe("");
    expect(listLabels([{ label: "JPEG" }])).toBe("JPEG");
    expect(listLabels([{ label: "JPEG" }, { label: "PNG" }, { label: "HEIC" }])).toBe(
      "JPEG, PNG and HEIC",
    );
  });

  test("summarises who opens a group", () => {
    expect(groupStatus(videos)).toBe("VistoGallery");
    expect(groupStatus(photos)).toBe("VistoGallery for 1 of 3");
    expect(groupStatus([photos[0], photos[2]])).toBe("Preview");
  });

  test("says where a run stopped", () => {
    expect(runNotice([photos[0]], null, "VistoGallery")).toBe("JPEG now opens with VistoGallery.");
    expect(runNotice([photos[0]], photos[2], "VistoGallery")).toBe(
      "JPEG now opens with VistoGallery. macOS kept the current app for HEIC, so nothing else was asked.",
    );
    expect(runNotice([], photos[0], "VistoGallery")).toMatch(/^Nothing changed\./);
  });
});

describe("DefaultAppsSection", () => {
  test("asks only for the types not already set, after a heads-up, one at a time", async () => {
    mocks.status.mockResolvedValue(status([...photos, ...videos, gif]));
    mocks.set.mockResolvedValue("changed");
    const showNotice = vi.fn();
    render(<DefaultAppsSection showNotice={showNotice} />);

    expect(await screen.findByText("VistoGallery for 1 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use VistoGallery" }));

    // Two dialogs ahead, so the heads-up comes first and nothing is asked yet.
    expect(screen.getByRole("dialog")).toHaveTextContent("2 dialogs");
    expect(mocks.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(showNotice).toHaveBeenCalledWith("JPEG and HEIC now open with VistoGallery."),
    );
    expect(mocks.set.mock.calls).toEqual([
      ["public.jpeg", "visto"],
      ["public.heic", "visto"],
    ]);
  });

  test("stops at the first type the user keeps", async () => {
    mocks.status.mockResolvedValue(status([...photos, ...videos]));
    mocks.set.mockResolvedValueOnce("declined");
    const showNotice = vi.fn();
    render(<DefaultAppsSection showNotice={showNotice} />);

    fireEvent.click(await screen.findByRole("button", { name: "Use VistoGallery" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(showNotice).toHaveBeenCalled());
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(showNotice.mock.calls[0][0]).toMatch(/^Nothing changed\. .*JPEG/);
  });

  test("a single type goes straight to macOS, and a full group offers the system app back", async () => {
    mocks.status.mockResolvedValue(status([...photos, ...videos, gif]));
    mocks.set.mockResolvedValue("changed");
    render(<DefaultAppsSection showNotice={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Use VistoGallery for GIF" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith("com.compuserve.gif", "visto"));

    expect(screen.getByRole("button", { name: "Use QuickTime Player" })).toBeInTheDocument();
  });

  test("explains why nothing can be changed outside the installed app", async () => {
    mocks.status.mockResolvedValue(status([...photos, ...videos], false));
    render(<DefaultAppsSection showNotice={vi.fn()} />);

    expect(
      await screen.findByText("Default apps can be set from the installed app."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

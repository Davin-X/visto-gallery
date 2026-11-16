import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CleanupScreen from "./CleanupScreen";
import type {
  CleanupOverview,
  JunkCategory,
  JunkCategoryReport,
  JunkItem,
  JunkSkip,
} from "../engine/types/commands";

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  clean: vi.fn(),
  reveal: vi.fn(),
  setIgnored: vi.fn(),
  setPersonalFolders: vi.fn(),
  listIgnored: vi.fn(),
  overview: vi.fn(),
  openTrash: vi.fn(),
}));

vi.mock("../engine/commands/tauri", () => ({
  tauri: { junk: mocks },
}));

const GB = 1024 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

const derived: JunkItem = {
  id: "xcode-derived-data",
  category: "xcode",
  label: "Xcode DerivedData",
  detail: "Build products and indexes — Xcode rebuilds them on the next build",
  path: "/Users/dev/Library/Developer/Xcode/DerivedData",
  bytes: GB,
  sharedBytes: 0,
  fileCount: 120,
  lastUsedAt: Date.now() - 2 * DAY,
  tier: "regenerable",
};

const archives: JunkItem = {
  id: "xcode-archives",
  category: "xcode",
  label: "Xcode Archives",
  detail: "Signed builds and dSYMs",
  path: "/Users/dev/Library/Developer/Xcode/Archives",
  bytes: 2048,
  sharedBytes: 0,
  fileCount: 2,
  lastUsedAt: null,
  tier: "rebuildable",
};

const modules: JunkItem = {
  id: "projects:/Users/dev/Code/app/node_modules",
  category: "projects",
  label: "app/node_modules",
  detail: "Dependencies in ~/Code/app — reinstall with npm, yarn or pnpm install",
  path: "/Users/dev/Code/app/node_modules",
  bytes: 4096,
  sharedBytes: 8192,
  fileCount: 40,
  lastUsedAt: Date.now() - 40 * DAY,
  tier: "rebuildable",
};

const busySkip: JunkSkip = {
  id: "npm-cache",
  category: "packages",
  label: "npm cache",
  path: "/Users/dev/.npm/_cacache",
  bytes: 3 * GB,
  reason: "appRunning",
  message: "npm is running",
};

const ignoredSkip: JunkSkip = {
  id: "homebrew-cache",
  category: "packages",
  label: "Homebrew cache",
  path: "/Users/dev/Library/Caches/Homebrew",
  bytes: GB,
  reason: "neverClean",
  message: "You marked this Never clean",
};

function report(
  category: JunkCategory,
  items: JunkItem[] = [],
  extra: Partial<JunkCategoryReport> = {},
): JunkCategoryReport {
  return {
    category,
    status: "complete",
    statusMessage: null,
    items,
    skips: [],
    totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    scannedAt: Date.now(),
    ...extra,
  };
}

const full: Record<JunkCategory, JunkCategoryReport> = {
  xcode: report("xcode", [derived, archives]),
  packages: report("packages", [], { skips: [busySkip, ignoredSkip] }),
  projects: report("projects", [modules], {
    status: "partial",
    statusMessage: "3 entries could not be read, so totals may be low.",
  }),
  downloads: report("downloads"),
};

const empty: Record<JunkCategory, JunkCategoryReport> = {
  xcode: report("xcode"),
  packages: report("packages"),
  projects: report("projects"),
  downloads: report("downloads"),
};

const overview: CleanupOverview = {
  disk: { totalBytes: 500 * GB, availableBytes: 100 * GB },
  personalFolders: true,
  library: {
    totalItems: 1200,
    totalBytes: 80 * GB,
    photoBytes: 30 * GB,
    videoBytes: 50 * GB,
    rawBytes: 0,
    largeVideoCount: 7,
    largeVideoBytes: 20 * GB,
  },
  history: [{ finishedAt: Date.now(), removedItems: 3, movedBytes: 5 * GB, failedItems: 0 }],
};

let reports = full;

function renderScreen(onOpenDuplicates?: () => void) {
  const showNotice = vi.fn();
  const showErrorNotice = vi.fn();
  const view = render(
    <CleanupScreen
      showNotice={showNotice}
      showErrorNotice={showErrorNotice}
      onOpenDuplicates={onOpenDuplicates}
    />,
  );
  return { ...view, showNotice, showErrorNotice };
}

beforeEach(() => {
  vi.clearAllMocks();
  reports = full;
  mocks.scan.mockImplementation((category: JunkCategory) => Promise.resolve(reports[category]));
  mocks.overview.mockResolvedValue(overview);
  mocks.listIgnored.mockResolvedValue([]);
  mocks.setIgnored.mockResolvedValue(undefined);
  mocks.setPersonalFolders.mockResolvedValue(undefined);
  mocks.reveal.mockResolvedValue(undefined);
  mocks.openTrash.mockResolvedValue(undefined);
});

describe("CleanupScreen", () => {
  it("scans every category in parallel and shows totals by tier", async () => {
    renderScreen();

    expect(await screen.findByText("Xcode DerivedData")).toBeInTheDocument();
    expect(mocks.scan.mock.calls.map(([category]) => category).sort()).toEqual([
      "downloads",
      "packages",
      "projects",
      "xcode",
    ]);
    expect(screen.getByRole("heading", { name: "Project build folders" })).toBeInTheDocument();
    expect(screen.getAllByText("Needs rebuild", { selector: ".cleanup-tier-chip" })).toHaveLength(
      2,
    );
    expect(screen.getByText("1.0 GB regenerates")).toBeInTheDocument();
    expect(screen.getByText("+8.0 KB shared")).toBeInTheDocument();
  });

  it("explains skipped items and partial scans instead of hiding them", async () => {
    renderScreen();
    await screen.findByText("Xcode DerivedData");

    expect(screen.getByText(/3 entries could not be read/)).toBeInTheDocument();
    expect(screen.getByText("npm is running")).toBeInTheDocument();
    expect(screen.getByText(/2 items skipped/)).toBeInTheDocument();
  });

  it("selects only regenerable items and cleans exactly those ids", async () => {
    mocks.clean.mockResolvedValueOnce({ removedItems: 1, movedBytes: GB, failed: [] });
    const { showNotice } = renderScreen();
    await screen.findByText("Xcode DerivedData");

    fireEvent.click(screen.getByRole("button", { name: /select everything that regenerates/i }));

    const bar = screen.getByRole("region", { name: "Cleanup selection" });
    expect(within(bar).getByText("1 item")).toBeInTheDocument();
    expect(within(bar).getByText("1.0 GB to the Trash")).toBeInTheDocument();

    fireEvent.click(within(bar).getByRole("button", { name: /move to trash/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/move 1 item to the trash\?/i)).toBeInTheDocument();

    reports = empty;
    fireEvent.click(within(dialog).getByRole("button", { name: /^move to trash$/i }));

    await waitFor(() => {
      expect(mocks.clean).toHaveBeenCalledWith(["xcode-derived-data"]);
    });
    // Success is the banner alone, and it is honest: the Trash still holds the space.
    expect(await screen.findByText(/when you empty the Trash/)).toBeInTheDocument();
    expect(screen.getByText(/Moved 1 item · 1.0 GB to the Trash/)).toBeInTheDocument();
    expect(showNotice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Trash" }));
    expect(mocks.openTrash).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText("Nothing to clean — your Mac is already tidy.")).toBeInTheDocument();
    });
  });

  it("lists what needs rebuilding before trashing it", async () => {
    renderScreen();
    await screen.findByText("Xcode DerivedData");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all Project build folders" }));
    fireEvent.click(screen.getByRole("button", { name: /move to trash/i }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/1 of these will need rebuilding/i)).toBeInTheDocument();
    expect(within(dialog).getByText("app/node_modules")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports a refused cleanup instead of claiming success", async () => {
    mocks.clean.mockResolvedValueOnce({
      removedItems: 0,
      movedBytes: 0,
      failed: [{ id: "xcode-archives", message: "Xcode is running — quit it and try again." }],
    });
    const { showNotice } = renderScreen();
    await screen.findByText("Xcode Archives");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Xcode Archives" }));
    fireEvent.click(screen.getByRole("button", { name: /move to trash/i }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^move to trash$/i }),
    );

    await waitFor(() => {
      expect(showNotice).toHaveBeenCalledWith("Xcode is running — quit it and try again.");
    });
    expect(await screen.findByText("Nothing was moved.")).toBeInTheDocument();
  });

  it("marks a row Never clean and allows a skipped one again", async () => {
    renderScreen();
    await screen.findByText("Xcode DerivedData");

    const row = screen.getByText("Xcode DerivedData").closest(".cleanup-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Never clean" }));
    await waitFor(() => {
      expect(mocks.setIgnored).toHaveBeenCalledWith(
        "xcode-derived-data",
        "Xcode DerivedData",
        true,
      );
    });

    const skip = screen.getByText("Homebrew cache").closest(".cleanup-skip") as HTMLElement;
    fireEvent.click(within(skip).getByRole("button", { name: "Allow" }));
    await waitFor(() => {
      expect(mocks.setIgnored).toHaveBeenCalledWith("homebrew-cache", "Homebrew cache", false);
    });
  });

  it("opens Finder for a row through the id", async () => {
    renderScreen();
    await screen.findByText("Xcode DerivedData");

    const row = screen.getByText("Xcode DerivedData").closest(".cleanup-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Show" }));

    expect(mocks.reveal).toHaveBeenCalledWith("xcode-derived-data");
  });

  it("shows the disk, the library footprint and history", async () => {
    const onOpenDuplicates = vi.fn();
    renderScreen(onOpenDuplicates);

    expect(await screen.findByText("Your photo library")).toBeInTheDocument();
    expect(screen.getByText(/7 videos over 1 GB/)).toBeInTheDocument();
    expect(screen.getByText("Free space")).toBeInTheDocument();
    expect(screen.getByText("100.0 GB")).toBeInTheDocument();
    expect(screen.getByText("101.0 GB")).toBeInTheDocument();
    expect(screen.getByText("+1%")).toBeInTheDocument();
    expect(screen.getByText("5.0 GB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /find duplicates/i }));
    expect(onOpenDuplicates).toHaveBeenCalled();
  });

  it("keeps the other categories when one scan fails", async () => {
    mocks.scan.mockImplementation((category: JunkCategory) =>
      category === "downloads"
        ? Promise.reject({ message: "Downloads is not readable" })
        : Promise.resolve(full[category]),
    );
    renderScreen();

    expect(await screen.findByText("Xcode DerivedData")).toBeInTheDocument();
    expect(await screen.findByText("Downloads is not readable")).toBeInTheDocument();
    expect(screen.getByText("Couldn’t scan")).toBeInTheDocument();
  });

  it("previews free space for the selection once something is selected", async () => {
    renderScreen();
    await screen.findByText("Xcode DerivedData");
    await screen.findByText("Free space");
    expect(screen.getByText(/If you clean everything listed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Xcode Archives" }));
    expect(screen.getByText(/With your selection/)).toBeInTheDocument();
    expect(screen.queryByText("101.0 GB")).not.toBeInTheDocument();
  });

  it("keeps Documents, Desktop and Downloads off until the user turns them on", async () => {
    mocks.overview.mockResolvedValue({ ...overview, personalFolders: false });
    reports = {
      ...full,
      downloads: report("downloads", [], {
        status: "off",
        statusMessage: "Turn on scanning of Documents, Desktop and Downloads.",
      }),
    };
    renderScreen();
    await screen.findByText("Xcode DerivedData");

    expect(screen.getByText("Off · turn on below")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Old installers" })).not.toBeInTheDocument();
    const toggle = await screen.findByRole("switch", {
      name: /also scan documents, desktop and downloads/i,
    });
    expect(toggle).not.toBeChecked();

    mocks.scan.mockClear();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(mocks.setPersonalFolders).toHaveBeenCalledWith(true);
    });
    await waitFor(() => {
      expect(mocks.scan).toHaveBeenCalledTimes(4);
    });
  });
});

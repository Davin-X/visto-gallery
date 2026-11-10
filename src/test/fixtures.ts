import type { MediaItem, Album, Tag, DuplicateGroup } from "../engine/types/media";
import type { LibraryFolder, LibraryItemsPage, LibraryStats } from "../engine/types/commands";

const NOW = 1_700_000_000_000;

export function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  const base: MediaItem = {
    id: "item-1",
    path: "/tmp/item-1.jpg",
    name: "item-1.jpg",
    extension: "jpg",
    kind: "photo",
    size: 1024,
    modifiedAt: NOW,
    capturedAt: NOW,
    favorite: false,
    hidden: false,
    isAnimated: false,
    tags: [],
    albumIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...base, ...overrides };
}

export function makeAlbum(overrides: Partial<Album> = {}): Album {
  const base: Album = {
    id: "album-1",
    name: "Trip",
    colorIndex: 0,
    itemCount: 0,
    itemIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...base, ...overrides };
}

export function makeTag(overrides: Partial<Tag> = {}): Tag {
  const base: Tag = {
    id: "tag-1",
    name: "Travel",
    colorIndex: 0,
    itemCount: 0,
    createdAt: NOW,
  };
  return { ...base, ...overrides };
}

export function makeLibraryFolder(overrides: Partial<LibraryFolder> = {}): LibraryFolder {
  const base: LibraryFolder = {
    path: "/tmp/Photos",
    name: "Photos",
    itemCount: 0,
    totalSize: 0,
    available: true,
  };
  return { ...base, ...overrides };
}

export function makeLibraryItemsPage(overrides: Partial<LibraryItemsPage> = {}): LibraryItemsPage {
  const base: LibraryItemsPage = {
    items: [],
    hasMore: false,
    totalCount: 0,
  };
  return { ...base, ...overrides };
}

export function makeDuplicateGroup(overrides: Partial<DuplicateGroup> = {}): DuplicateGroup {
  const base: DuplicateGroup = {
    id: "group-1",
    sha256: "abc123",
    size: 1024,
    items: [],
  };
  return { ...base, ...overrides };
}

export function makeLibraryStats(overrides: Partial<LibraryStats> = {}): LibraryStats {
  const base: LibraryStats = {
    photos: 0,
    videos: 0,
    raws: 0,
    animations: 0,
    uncategorized: 0,
    favorites: 0,
    hidden: 0,
    photoSize: 0,
    videoSize: 0,
    rawSize: 0,
    uncategorizedSize: 0,
    favoriteSize: 0,
    hiddenSize: 0,
    totalSize: 0,
  };
  return { ...base, ...overrides };
}

/** Build a small, self-consistent library fixture for store/screen tests.
 *
 * Defaults: 3 photos, 1 video, 1 RAW, 1 hidden item, 1 album, 1 tag, 1 folder.
 * Items are spread across dates so sort-order tests are deterministic.
 */
export function makeLibraryFixture(
  overrides: {
    itemCount?: number;
    photoCount?: number;
    videoCount?: number;
    rawCount?: number;
    hiddenCount?: number;
    startId?: number;
  } = {},
): {
  items: MediaItem[];
  albums: Album[];
  tags: Tag[];
  folders: LibraryFolder[];
} {
  const {
    itemCount = 5,
    photoCount = 3,
    videoCount = 1,
    rawCount = 1,
    hiddenCount = 1,
    startId = 1,
  } = overrides;

  const items: MediaItem[] = [];
  let id = startId;

  for (let i = 0; i < photoCount; i++) {
    items.push(
      makeMediaItem({
        id: `item-${id++}`,
        path: `/tmp/photo${i}.jpg`,
        name: `photo${i}.jpg`,
        extension: "jpg",
        kind: "photo",
        size: 1024 * (i + 1),
        modifiedAt: NOW + i * 1000,
        capturedAt: NOW + i * 1000,
        favorite: i === 0,
        hidden: false,
      }),
    );
  }
  for (let i = 0; i < videoCount; i++) {
    items.push(
      makeMediaItem({
        id: `item-${id++}`,
        path: `/tmp/video${i}.mp4`,
        name: `video${i}.mp4`,
        extension: "mp4",
        kind: "video",
        size: 1024 * 100 * (i + 1),
        modifiedAt: NOW + (photoCount + i) * 1000,
        capturedAt: undefined,
        favorite: false,
        hidden: false,
      }),
    );
  }
  for (let i = 0; i < rawCount; i++) {
    items.push(
      makeMediaItem({
        id: `item-${id++}`,
        path: `/tmp/raw${i}.dng`,
        name: `raw${i}.dng`,
        extension: "dng",
        kind: "raw",
        size: 1024 * 1000 * (i + 1),
        modifiedAt: NOW + (photoCount + videoCount + i) * 1000,
        capturedAt: NOW + (photoCount + videoCount + i) * 1000,
        favorite: false,
        hidden: false,
      }),
    );
  }
  for (let i = 0; i < hiddenCount; i++) {
    items.push(
      makeMediaItem({
        id: `item-${id++}`,
        path: `/tmp/hidden${i}.jpg`,
        name: `hidden${i}.jpg`,
        extension: "jpg",
        kind: "photo",
        size: 1024 * 10,
        modifiedAt: NOW + (photoCount + videoCount + rawCount + i) * 1000,
        capturedAt: NOW + (photoCount + videoCount + rawCount + i) * 1000,
        favorite: false,
        hidden: true,
      }),
    );
  }

  // Fill remaining with photos if itemCount exceeds specific counts.
  const specified = photoCount + videoCount + rawCount + hiddenCount;
  for (let i = specified; i < itemCount; i++) {
    items.push(
      makeMediaItem({
        id: `item-${id++}`,
        path: `/tmp/extra${i}.jpg`,
        name: `extra${i}.jpg`,
        extension: "jpg",
        kind: "photo",
        size: 1024 * (i + 1),
        modifiedAt: NOW + (photoCount + videoCount + rawCount + hiddenCount + i) * 1000,
        capturedAt: NOW + (photoCount + videoCount + rawCount + hiddenCount + i) * 1000,
        favorite: false,
        hidden: false,
      }),
    );
  }

  const albums: Album[] = [
    makeAlbum({ id: "album-1", name: "Trip", itemCount: 2, itemIds: ["item-1", "item-2"] }),
    makeAlbum({ id: "album-2", name: "Vacation", itemCount: 0, itemIds: [] }),
  ];
  const tags: Tag[] = [
    makeTag({ id: "tag-1", name: "Travel", colorIndex: 0, itemCount: 1 }),
    makeTag({ id: "tag-2", name: "Nature", colorIndex: 1, itemCount: 0 }),
  ];
  const folders: LibraryFolder[] = [
    makeLibraryFolder({ path: "/tmp/Photos", name: "Photos", itemCount: 4, totalSize: 4096 }),
    makeLibraryFolder({ path: "/tmp/Videos", name: "Videos", itemCount: 1, totalSize: 102400 }),
  ];

  return { items, albums, tags, folders };
}

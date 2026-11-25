// Fails when a source file grows past MAX_LINES. Files already over it are
// listed with their current size and may shrink but never grow (a ratchet).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MAX_LINES = 1000;
const PATTERNS = ["src/*.ts", "src/*.tsx", "src-tauri/src/*.rs", "scripts/*.mjs", "e2e/*.ts"];

// Lower a number (or delete the entry) when you split a file. Never raise one.
const OVERSIZED = {
  "src-tauri/src/commands/library.rs": 1810,
  "src-tauri/src/commands/media.rs": 3608,
  "src-tauri/src/commands/junk.rs": 3175,
  "src/screens/LibraryScreen.tsx": 3003,
  "src/engine/stores/useLibraryStore.ts": 2134,
  "src/screens/DuplicatesScreen.tsx": 1810,
  "src/screens/EditScreen.tsx": 1769,
  "src-tauri/src/commands/playback.rs": 1036,
  "src/design/components/VideoPlayer.tsx": 1510,
  "src-tauri/src/commands/backup.rs": 1389,
  "src/engine/stores/useLibraryStore.test.ts": 1338,
  "src-tauri/src/commands/batch.rs": 1304,
  "src/screens/ViewerScreen.tsx": 1200,
  "src/screens/CleanupScreen.tsx": 1172,
  "src/app/AppDialogs.tsx": 1137,
  "src-tauri/src/commands/edit_recipes.rs": 1101,
  "src-tauri/src/commands/file_duplicates.rs": 1040,
};

const files = execFileSync("git", ["ls-files", ...PATTERNS], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const problems = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n").length - 1;
  const cap = OVERSIZED[file] ?? MAX_LINES;
  if (lines > cap) {
    problems.push(
      file in OVERSIZED
        ? `${file}: ${lines} lines, was ${cap}. It is already over ${MAX_LINES}; split it instead of growing it.`
        : `${file}: ${lines} lines (max ${MAX_LINES}). Split it into smaller modules.`,
    );
  } else if (file in OVERSIZED && lines < cap) {
    problems.push(`${file}: shrank to ${lines} lines. Lower its entry in OVERSIZED to ${lines}${lines <= MAX_LINES ? " (or remove it)" : ""}.`);
  }
}
for (const file of Object.keys(OVERSIZED)) {
  if (!files.includes(file)) problems.push(`${file}: no longer exists. Remove it from OVERSIZED.`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`file sizes ok: ${files.length} files`);

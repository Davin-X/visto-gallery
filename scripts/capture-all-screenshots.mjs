#!/usr/bin/env node
// Captures the README screenshots (`docs/screenshots/<screen>-<theme>.jpg`)
// from a running VistoGallery window on macOS.
//
// The shots are window captures of the real app, not browser renders, because
// the README advertises the native window: traffic lights, sidebar totals and
// the version in the footer are all part of the picture. A browser would need
// the Playwright harness, whose synthetic fixtures are one-pixel thumbnails.
//
// Each screen is a *recipe*: an ordered list of accessibility steps (press a
// labelled control, toggle the window full screen) executed before the capture,
// plus optional restore steps that put the window back afterwards. Labels are
// the ones the app exposes to the Accessibility API; `--dump` prints them for
// the current screen when a recipe needs correcting.
//
// Requirements, both macOS privacy prompts granted to the app running this
// script (Terminal, iTerm, or the editor's terminal):
//   - Screen Recording, for `screencapture -l`.
//   - Accessibility, to resize the window and drive the controls.
//
// Usage:
//   npm run screenshots                        # every recipe, both themes
//   npm run screenshots -- --only library      # one screen
//   npm run screenshots -- --theme dark        # one theme
//   npm run screenshots -- --dry-run --only albums
//   npm run screenshots -- --list
//   npm run screenshots -- --dump              # labels on the current screen
//
// Selection-dependent recipes (album-view, viewer, editor-drafts) need a photo
// selected; press `--only viewer --no-steps` after arranging it by hand.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import process from "node:process";

const APP = "VistoGallery";
const OUT_DIR = path.resolve("docs/screenshots");
const WORK_DIR = path.resolve("node_modules/.cache/visto-screenshots");
const HELPER_SRC = path.resolve("scripts/macos-window.swift");
const HELPER_BIN = path.join(WORK_DIR, "macos-window");

// Steps, in order. `press` matches an accessible label by substring; `fullscreen`
// toggles the window's native full-screen state.
const SCREENS = [
  { name: "library", steps: [{ press: "Grid view" }], expect: "Library" },
  { name: "library-grid", steps: [{ press: "Grid view" }], expect: "Library" },
  { name: "library-list", steps: [{ press: "Details view" }], expect: "Library" },
  { name: "library-timeline", steps: [{ press: "Timeline view" }], expect: "Library" },
  {
    name: "library-collapsed",
    steps: [{ press: "Grid view" }, { press: "Hide sidebar" }],
    restore: [{ press: "Show sidebar" }],
    expect: "Library",
  },
  {
    name: "library-selected",
    steps: [
      { press: "Grid view" },
      { press: "Show inspector", whenAbsent: "Hide inspector" },
      { press: "Open Alone in the Unspoilt Wilderness" },
    ],
    restore: [{ press: "Hide inspector", whenAbsent: "Show inspector" }],
    expect: "Library",
  },
  {
    name: "library-fullscreen",
    steps: [{ fullscreen: true }],
    restore: [{ fullscreen: false }],
    expect: "Library",
  },
  { name: "albums", steps: [{ press: "Albums" }], expect: "Albums" },
  {
    name: "duplicates",
    steps: [{ press: "Duplicates" }, { press: "Scan library", whenAbsent: "Compare" }, { wait: 4 }],
    expect: "Duplicates",
  },
  { name: "hidden", steps: [{ press: "Hidden" }], expect: "Hidden" },
  { name: "edit", steps: [{ press: "Edit" }], expect: "Edit" },
  {
    name: "edit-editor",
    steps: [{ press: "Edit" }, { pressPrefix: "Sunrise at Hercules" }, { wait: 2 }],
    expect: "Edit",
  },
  {
    name: "viewer",
    steps: [
      { press: "Grid view" },
      { press: "Open Pyrenees Valley" },
      { key: "return", meta: true },
    ],
    restore: [{ key: "escape" }],
    expect: "Viewer",
  },
  {
    name: "library-icons",
    steps: [{ press: "Grid view" }, { press: "Collapse sidebar to icons" }],
    restore: [{ press: "Expand sidebar" }],
    expect: "Library",
  },
  {
    name: "album-view",
    steps: [
      { press: "Albums" },
      { wait: 2.5 },
      { press: "Collapse sidebar to icons" },
      { wait: 0.5 },
      { pressContains: "Alpine Weekend" },
    ],
    restore: [{ press: "Expand sidebar" }],
    expect: "Alpine Weekend",
  },
  {
    name: "duplicates-compare",
    steps: [
      { press: "Duplicates" },
      { press: "Scan library", whenAbsent: "Compare" },
      { wait: 4 },
      { pressPrefix: "Compare " },
    ],
    restore: [{ press: "Close" }],
    modal: true,
  },
  {
    name: "settings",
    steps: [{ press: "Settings" }],
    restore: [{ press: "Settings" }],
    expect: "Settings",
  },
  {
    name: "settings-viewing",
    steps: [{ press: "Settings" }, { tab: "Viewing" }],
    restore: [{ press: "Settings" }],
    expect: "Settings",
  },
  {
    name: "settings-library",
    steps: [{ press: "Settings" }, { tab: "Library" }],
    restore: [{ press: "Settings" }],
    expect: "Settings",
  },
  {
    name: "settings-advanced",
    steps: [{ press: "Settings" }, { tab: "Advanced" }],
    restore: [{ press: "Settings" }],
    expect: "Settings",
  },
  {
    name: "settings-privacy",
    steps: [{ press: "Settings" }, { tab: "Privacy" }],
    restore: [{ press: "Settings" }],
    expect: "Settings",
  },
  {
    name: "sources",
    steps: [{ press: "Sources" }],
    restore: [{ press: "Close" }],
    modal: true,
    expect: "Sources",
  },
  // Last: playback keeps a Now Playing chip in the top bar of every later screen.
  {
    name: "player",
    steps: [
      { press: "Grid view" },
      { press: "Open Earth From Orbit" },
      { key: "return", meta: true },
      { wait: 2 },
    ],
    restore: [{ key: "escape" }],
  },
];

const DEFAULTS = {
  app: APP,
  width: 1600,
  height: 1000,
  theme: "both",
  only: null,
  steps: true,
  dryRun: false,
  accents: [null],
};

function die(message, code = 1) {
  console.error(`screenshots: ${message}`);
  process.exit(code);
}

function printHelp() {
  console.log(`Capture README screenshots from the running ${APP} window.

  --only a,b      screens to capture (see --list)
  --theme t       both (default), light or dark
  --accent a,b    accent colours to capture (blue, purple, green, orange, pink, red)
  --width n       window width in points (default 1600)
  --height n      window height in points (default 1000)
  --no-steps      capture the current screen, ignoring the recipe
  --dry-run       run the recipes but skip the capture
  --list          print the recipe names and steps
  --dump          print every accessible label on the current screen
  --app name      window owner name to match (default ${APP})

Output: docs/screenshots/<screen>-<theme>.jpg, resized to the window width.

The script sets appearance, size and the screen itself, but not selection: a
recipe that needs a photo open (album-view, viewer, editor drafts) only gets
there if you select one first. The inspector starts closed in 0.4.0, so
"library-selected" opens it.`);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (value == null || value.startsWith("--")) die(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--list") {
      for (const screen of SCREENS) {
        const steps = screen.steps.length
          ? screen.steps.map((s) => (s.press ? `press "${s.press}"` : `fullscreen ${s.fullscreen}`))
          : ["(as it stands)"];
        console.log(`${screen.name.padEnd(20)} ${steps.join(" → ")}`);
      }
      process.exit(0);
    } else if (arg === "--dump") options.dump = true;
    else if (arg === "--only") options.only = takeValue().split(",").filter(Boolean);
    else if (arg === "--theme") options.theme = takeValue();
    else if (arg === "--width") options.width = Number(takeValue());
    else if (arg === "--height") options.height = Number(takeValue());
    else if (arg === "--app") options.app = takeValue();
    else if (arg === "--accent") {
      options.accents = takeValue()
        .split(",")
        .filter(Boolean)
        .map((name) => name.toLowerCase());
    }
    else if (arg === "--no-steps") options.steps = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else die(`unrecognised argument ${arg} (see --help)`);
  }
  if (!["both", "light", "dark"].includes(options.theme)) die(`--theme must be both, light or dark`);
  for (const accent of options.accents) {
    if (accent && !ACCENTS.includes(accent)) die(`--accent must be one of ${ACCENTS.join(", ")}`);
  }
  if (!Number.isFinite(options.width) || !Number.isFinite(options.height)) {
    die(`--width and --height must be numbers`);
  }
  return options;
}

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

function ensureHelper() {
  mkdirSync(WORK_DIR, { recursive: true });
  const fresh =
    existsSync(HELPER_BIN) &&
    existsSync(HELPER_SRC) &&
    statSync(HELPER_BIN).mtimeMs >= statSync(HELPER_SRC).mtimeMs;
  if (fresh) return;
  console.log("screenshots: compiling the window helper");
  const build = run("swiftc", ["-O", HELPER_SRC, "-o", HELPER_BIN]);
  if (build.status !== 0) {
    die(`could not compile ${path.relative(process.cwd(), HELPER_SRC)}\n${build.stderr || ""}`);
  }
}

const CATALOG = path.join(
  homedir(),
  "Library/Application Support/com.vistogallery.desktop/visto-gallery.db",
);

/// The saved accent lives in the catalog's settings table; reading it means a
/// recipe can put the user's own accent back when it is done.
function savedAccent() {
  const result = run("sqlite3", ["-readonly", CATALOG, "select value from settings where key = 'accent_color';"]);
  const value = (result.stdout || "").trim();
  return result.status === 0 && value ? value : null;
}

const ACCENTS = ["blue", "purple", "green", "orange", "pink", "red"];

function selectAccent(accent, options) {
  const capitalised = accent[0].toUpperCase() + accent.slice(1);
  helper(["press", options.app, "Settings"]);
  execFileSync("sleep", ["0.7"]);
  helper(["press-role", options.app, "RadioButton", capitalised]);
  execFileSync("sleep", ["0.4"]);
  helper(["press", options.app, "Settings"]);
  execFileSync("sleep", ["0.4"]);
}

function helper(args, { allowFailure = false } = {}) {
  const result = run(HELPER_BIN, args);
  if (result.status !== 0 && !allowFailure) {
    die(`${args[0]} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  const output = (result.stdout || "").trim();
  const first = output.split("\n")[0] ?? "";
  try {
    return JSON.parse(first || "{}");
  } catch {
    return { raw: output, status: result.status };
  }
}

function dumpLabels(app) {
  const result = run(HELPER_BIN, ["dump", app]);
  const lines = (result.stdout || "").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const { role, text } = JSON.parse(line);
      console.log(`  ${role.replace(/^AX/, "").padEnd(12)} ${text}`);
    } catch {
      console.log(`  ${line}`);
    }
  }
}

function preflight(options) {
  if (process.platform !== "darwin") die("this script captures a macOS window and only runs on macOS");
  if (run("which", ["screencapture"]).status !== 0) die("screencapture is missing");

  const window = helper(["find", options.app], { allowFailure: true });
  if (!window.windowId) {
    die(`${APP} is not running with a visible window.\nStart it first (open the installed app, or run \`npm run tauri:dev\`).`);
  }

  const trust = helper(["trust"], { allowFailure: true });
  if (!trust.accessibilityTrusted) {
    die(
      "Accessibility permission is missing, so the window cannot be resized and the\n" +
        "recipes cannot be driven.\n\n" +
        "Grant it in System Settings → Privacy & Security → Accessibility for the app\n" +
        "running this terminal, then run again.",
      3,
    );
  }

  if (options.dryRun) return window;

  const probe = path.join(WORK_DIR, "probe.png");
  const capture = run("screencapture", ["-l", String(window.windowId), "-o", "-x", probe]);
  if (capture.status !== 0 || !existsSync(probe)) {
    die(
      "screencapture could not read the window. Grant Screen Recording in\n" +
        "System Settings → Privacy & Security → Screen Recording for the app running\n" +
        "this terminal, then run again.\n" +
        (capture.stderr || "").trim(),
      3,
    );
  }
  rmSync(probe, { force: true });
  return window;
}

function hasLabel(label, options) {
  const result = helper(["has", options.app, label], { allowFailure: true });
  return result.found === true;
}

function headings(options) {
  const result = run(HELPER_BIN, ["headings", options.app]);
  return (result.stdout || "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line).text;
      } catch {
        return line;
      }
    });
}

// A capture script must never change library state. Labels that remove or
// clear anything are refused outright, so a look-alike match can only fail
// loudly instead of deleting a source, an album or a tag.
const DESTRUCTIVE = /(remove|delete|trash|erase|clear|reset all|uninstall)/i;

function refuseIfDestructive(label) {
  if (DESTRUCTIVE.test(label)) {
    die(`refusing to press "${label}": capture recipes must not modify the library`);
  }
}

function applyStep(step, options) {
  if (step.wait) {
    execFileSync("sleep", [String(step.wait)]);
    return { ok: true, detail: `waited ${step.wait}s` };
  }
  if (step.tab) {
    refuseIfDestructive(step.tab);
    // Settings tabs are radio buttons; the sidebar has buttons with the same
    // text, so scope the press to the role.
    const result = helper(["press-role", options.app, "RadioButton", step.tab], {
      allowFailure: true,
    });
    return result.pressedRole
      ? { ok: true, detail: `selected the ${step.tab} tab` }
      : { ok: false, detail: `no radio tab labelled "${step.tab}"` };
  }
  if (step.pressContains) {
    refuseIfDestructive(step.pressContains);
    const result = helper(["press-contains", options.app, step.pressContains], { allowFailure: true });
    return result.pressedContains
      ? { ok: true, detail: `pressed first control containing "${step.pressContains}"` }
      : { ok: false, detail: `no control containing "${step.pressContains}"` };
  }
  if (step.pressPrefix) {
    refuseIfDestructive(step.pressPrefix);
    const result = helper(["press-prefix", options.app, step.pressPrefix], { allowFailure: true });
    return result.pressedPrefix
      ? { ok: true, detail: `pressed first control starting "${step.pressPrefix}"` }
      : { ok: false, detail: `no control starting "${step.pressPrefix}"` };
  }
  if (step.key) {
    const args = ["key", options.app, step.key];
    if (step.meta) args.push("meta");
    const result = helper(args, { allowFailure: true });
    return result.key
      ? { ok: true, detail: `pressed ${step.meta ? "⌘" : ""}${step.key}` }
      : { ok: false, detail: `could not send ${step.key}` };
  }
  if (step.press) {
    refuseIfDestructive(step.press);
    // Controls that describe their own state ("Show inspector" / "Hide
    // inspector") only exist in one of the two states, so recipes gate on the
    // opposite label instead of assuming a starting point.
    if (step.whenAbsent && hasLabel(step.whenAbsent, options)) {
      return { ok: true, detail: `skipped "${step.press}" ("${step.whenAbsent}" present)` };
    }
    if (step.whenPresent && !hasLabel(step.whenPresent, options)) {
      return { ok: true, detail: `skipped "${step.press}" ("${step.whenPresent}" missing)` };
    }
    const result = helper(["press", options.app, step.press], { allowFailure: true });
    return result.pressed
      ? { ok: true, detail: `pressed "${step.press}"` }
      : { ok: false, detail: `no control labelled "${step.press}"` };
  }
  if (step.fullscreen != null) {
    const result = helper(["fullscreen", options.app, step.fullscreen ? "on" : "off"], {
      allowFailure: true,
    });
    return result.fullscreen === step.fullscreen
      ? { ok: true, detail: `fullscreen ${step.fullscreen}` }
      : { ok: false, detail: `could not set fullscreen ${step.fullscreen}` };
  }
  return { ok: false, detail: `unknown step ${JSON.stringify(step)}` };
}

function captureScreen(screenName, theme, options, display = false) {
  const png = path.join(WORK_DIR, `${screenName}-${theme}.png`);
  const resized = path.join(WORK_DIR, `${screenName}-${theme}-resized.png`);
  const target = path.join(OUT_DIR, `${screenName}-${theme}.jpg`);

  const captureArgs = display
    ? ["-D", "1", "-x", png]
    : (() => {
        const window = helper(["find", options.app], { allowFailure: true });
        if (!window.windowId) die(`lost the ${APP} window`);
        return ["-l", String(window.windowId), "-o", "-x", png];
      })();
  const capture = run("screencapture", captureArgs);
  if (capture.status !== 0) die(`capture failed for ${screenName}: ${(capture.stderr || "").trim()}`);

  const scale = run("sips", ["--resampleWidth", String(options.width), png, "--out", resized]);
  if (scale.status !== 0) die(`resize failed for ${screenName}: ${(scale.stderr || "").trim()}`);

  const convert = run("sips", [
    "--cropToHeightWidth",
    String(options.height),
    String(options.width),
    "-s",
    "format",
    "jpeg",
    "-s",
    "formatOptions",
    "90",
    resized,
    "--out",
    target,
  ]);
  if (convert.status !== 0) die(`encode failed for ${screenName}: ${(convert.stderr || "").trim()}`);

  const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", target], {
    encoding: "utf8",
  });
  const width = Number(info.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(info.match(/pixelHeight:\s*(\d+)/)?.[1]);
  console.log(`  ${path.relative(process.cwd(), target)}  ${width}x${height}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureHelper();

  if (options.dump) {
    console.log(`labels on the current ${APP} screen:`);
    dumpLabels(options.app);
    return;
  }

  const wanted = options.only
    ? SCREENS.filter((screen) => options.only.includes(screen.name))
    : SCREENS;
  if (wanted.length === 0) die(`no known screen in --only ${options.only.join(",")}`);

  const window = preflight(options);
  helper(["resize", options.app, String(options.width), String(options.height)]);
  console.log(
    `screenshots: ${window.owner} ${options.width}x${options.height}pt, ` +
      `${wanted.length} recipe(s), ${options.theme}${options.dryRun ? ", dry run" : ""}`,
  );

  const themes = options.theme === "both" ? ["light", "dark"] : [options.theme];
  if (!options.dryRun) mkdirSync(OUT_DIR, { recursive: true });

  for (const screen of wanted) {
    console.log(`\n${screen.name}`);
    if (options.steps) {
      // Start every recipe from a known place: windowed (full screen hides the
      // sidebar), sidebar expanded, Library screen. Otherwise one recipe's
      // layout choice leaks into the next.
      helper(["fullscreen", options.app, "off"], { allowFailure: true });
      // The sidebar toggle reads "Show sidebar" while collapsed and
      // "Hide sidebar" while expanded, so only one of these can match.
      helper(["press", options.app, "Show sidebar"], { allowFailure: true });
      helper(["press", options.app, "Expand sidebar"], { allowFailure: true });
      const reset = helper(["press", options.app, "Library"], { allowFailure: true });
      if (!reset.pressed) console.log("  warn could not reset to the Library screen");
      execFileSync("sleep", ["0.4"]);
      for (const step of screen.steps) {
        const result = applyStep(step, options);
        console.log(`  ${result.ok ? "ok  " : "FAIL"} ${result.detail}`);
        if (!result.ok) {
          console.log("  labels available on this screen:");
          dumpLabels(options.app);
          die(`recipe for ${screen.name} does not match the app; fix the step or file an issue`);
        }
        execFileSync("sleep", ["1.0"]);
      }
    }
    if (screen.expect && screen.name !== "library-fullscreen") {
      // The screen heading is the only cheap proof that the presses landed on
      // the intended view rather than on a look-alike control.
      const seen = headings(options).slice(0, 3).join(" · ");
      const ok = seen.toLowerCase().includes(screen.expect.toLowerCase());
      console.log(`  ${ok ? "ok  " : "FAIL"} heading "${screen.expect}" (saw: ${seen})`);
      if (!ok) {
        dumpLabels(options.app);
        die(`recipe for ${screen.name} did not reach the ${screen.expect} screen`);
      }
    }
    if (options.dryRun) {
      for (const step of screen.restore ?? []) {
        const result = applyStep(step, options);
        if (!result.ok) console.log(`  warn ${result.detail}`);
        execFileSync("sleep", ["0.3"]);
      }
      continue;
    }
    for (const accent of options.accents) {
      if (accent) selectAccent(accent, options);
      for (const theme of themes) {
        // A dialog hides the top bar's appearance button from Accessibility, so
        // modal recipes close the dialog, switch the theme, then open it again.
        if (screen.modal) {
          for (const step of screen.restore ?? []) applyStep(step, options);
          execFileSync("sleep", ["0.5"]);
        }
        const state = helper(["appearance", options.app, theme], { allowFailure: true });
        if (screen.modal) {
          for (const step of screen.steps) {
            const result = applyStep(step, options);
            if (!result.ok) die(`recipe for ${screen.name} failed in ${theme}: ${result.detail}`);
            execFileSync("sleep", ["1.0"]);
          }
        }
        if (!state.matched) {
          die(`could not switch to the ${theme} appearance (current: ${state.appearance ?? "unknown"})`);
        }
        execFileSync("sleep", ["0.4"]);
        const label = accent ? `${screen.name}-${accent}` : screen.name;
        captureScreen(label, theme, options, screen.name === "library-fullscreen");
      }
    }
    for (const step of screen.restore ?? []) {
      const result = applyStep(step, options);
      if (!result.ok) console.log(`  warn ${result.detail}`);
      execFileSync("sleep", ["0.3"]);
    }
  }

  if (options.accents.some(Boolean)) {
    const original = savedAccent();
    if (original) {
      selectAccent(original, options);
      console.log(`\nrestored the saved accent (${original})`);
    } else {
      console.log("\nwarn could not read the saved accent; check Settings → Appearance");
    }
  }

  console.log("\nscreenshots: done");
}

main();

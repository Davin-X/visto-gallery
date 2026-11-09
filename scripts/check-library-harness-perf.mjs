import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runLibraryHarnessBenchmark } from "./benchmark-library-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(__dirname, "../perf/library-harness-baseline.json");
const RECORD = process.argv.includes("--record");
const PORT = Number(process.env.LIBRARY_BENCHMARK_PORT || 4175);
const ORIGIN = process.env.LIBRARY_BENCHMARK_ORIGIN || `http://127.0.0.1:${PORT}`;

function readBaseline() {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
}

async function waitForServer(origin, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/harness.html`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Harness not ready at ${origin}`);
}

function compare(metrics, thresholds) {
  const failures = [];
  for (const [key, rule] of Object.entries(thresholds)) {
    const value = metrics[key];
    if (value == null || Number.isNaN(value)) {
      failures.push(`${key}: missing metric (got ${value})`);
      continue;
    }
    if (rule.max != null && value > rule.max) {
      failures.push(`${key}: ${value} > max ${rule.max} ${rule.unit || ""} (${rule.meaning || ""})`);
    }
    if (rule.min != null && value < rule.min) {
      failures.push(`${key}: ${value} < min ${rule.min} ${rule.unit || ""} (${rule.meaning || ""})`);
    }
  }
  return failures;
}

let preview = null;
if (!process.env.LIBRARY_BENCHMARK_ORIGIN) {
  preview = spawn(
    "npx",
    ["vite", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
    { stdio: "ignore" },
  );
}

try {
  await waitForServer(ORIGIN);
  const baseline = readBaseline();
  const items = Number(process.env.LIBRARY_BENCHMARK_ITEMS || baseline.items || 50_000);
  const metrics = await runLibraryHarnessBenchmark({ items, origin: ORIGIN });

  console.log("Performance metrics:\n" + JSON.stringify(metrics, null, 2));

  if (RECORD) {
    baseline.reference = {
      recordedAt: new Date().toISOString(),
      environment: process.env.CI ? "ci" : "local",
      items,
      metrics: {
        firstUsefulScreenMs: metrics.firstUsefulScreenMs,
        albumsOverviewMs: metrics.albumsOverviewMs,
        maxActiveThumbnails: metrics.maxActiveThumbnails,
        mountedTiles: metrics.mountedTiles,
        albumCards: metrics.albumCards,
      },
    };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`\nRecorded reference metrics to ${path.relative(process.cwd(), BASELINE_PATH)} (thresholds unchanged).`);
    process.exit(0);
  }

  const failures = compare(metrics, baseline.thresholds);
  if (failures.length) {
    console.error("\nPerformance regression gate FAILED:");
    for (const f of failures) console.error(" - " + f);
    console.error(`\nThresholds: ${path.relative(process.cwd(), BASELINE_PATH)}`);
    console.error("If the change is intentional, update thresholds deliberately (see _meta.howToUpdate).");
    process.exit(1);
  }
  console.log("\nPerformance regression gate passed.");
} finally {
  preview?.kill("SIGTERM");
}

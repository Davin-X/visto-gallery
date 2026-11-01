import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    host: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "safari14",
    rollupOptions: {
      input: {
        main: "index.html",
        harness: "harness.html",
      },
    },
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true,
    // Local worktrees under .kilo/ contain their own copies of these tests;
    // collecting them inflates counts and can fail on stale code.
    exclude: ["**/node_modules/**", "**/dist/**", ".kilo/**"],
  },
});

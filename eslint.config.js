import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettierPlugin from "eslint-plugin-prettier";

export default [
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: process.cwd(),
        warnOnUnsupportedTypeScriptVersion: false,
      },
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      react: reactPlugin,
      "react-hooks": reactHooks,
      prettier: prettierPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "react/display-name": "off",
      "react/prop-types": "off",
      "no-console": "warn",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "prettier/prettier": "error",
    },
    settings: {
      react: { version: "18.3" },
    },
  },
  {
    // Tests build loose doubles on purpose: a partial item or a fake event is
    // easier to read than a fully typed stand-in, and the type checker still
    // covers the code under test.
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", ".kilo/", "untracked/", "src-tauri/target/", "src/engine/types/generated/", "*.config.js", "*.config.mjs"],
  },
];

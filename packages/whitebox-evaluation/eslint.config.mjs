import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".local-analysis/**",
      ".local-cases/**",
      ".opencode/**",
      ".superpowers/**",
      ".swift-cache/**",
      ".worktrees/**",
      "init-input/**",
      "docs/**",
      "references/**",
    ],
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "no-console": "off",
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);

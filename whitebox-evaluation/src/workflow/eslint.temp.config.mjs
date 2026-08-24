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
    files: ["src/workflow/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      complexity: ["error", { max: 20 }],
      "max-depth": ["error", 4],
      "max-lines": ["error", { max: 1000, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": [
        "error",
        { max: 50, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      "max-params": ["error", 5],
      "no-console": "off",
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);

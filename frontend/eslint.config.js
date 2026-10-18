import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import hooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["**/node_modules/**", "**/dist/**"] },
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { react, "react-hooks": hooks },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "react/jsx-uses-vars": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["**/tests/react/**", "**/tests/e2e/**", "**/*config.js"],
    rules: { "no-unused-vars": "error" },
  },
];

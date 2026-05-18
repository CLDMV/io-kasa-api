// Root ESLint flat config for the quacklgtm TypeScript ESM monorepo.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["**/dist/**", "**/node_modules/**", "**/out/**", "**/.vite/**", "docs/**", "types/**"],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		// TypeScript sources. tseslint disables core no-undef here (TS checks it).
		files: ["**/*.{ts,mts,cts}"],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: "module",
		},
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/consistent-type-imports": "error",
		},
	},
	{
		// Plain JS / ESM scripts (dev-guard, config files) — Node runtime.
		files: ["**/*.{js,mjs,cjs}"],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: "module",
			globals: globals.node,
		},
	}
);

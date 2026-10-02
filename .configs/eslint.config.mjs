/**
 *
 *	@Project: @cldmv/io-kasa-api
 *	@Filename: /.configs/eslint.config.mjs
 *	@Date: 2026-05-18T08:50:20-07:00 (1779119420)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:32:38-07:00 (1790969558)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

// Root ESLint flat config for the quacklgtm TypeScript ESM monorepo.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["**/dist/**", "**/node_modules/**", "**/out/**", "**/.vite/**", "docs/**", "types/**"]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		// TypeScript sources. tseslint disables core no-undef here (TS checks it).
		files: ["**/*.{ts,mts,cts}"],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: "module"
		},
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_"
				}
			],
			"@typescript-eslint/consistent-type-imports": "error"
		}
	},
	{
		// Plain JS / ESM scripts (dev-guard, config files) — Node runtime.
		files: ["**/*.{js,mjs,cjs}"],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: "module",
			globals: globals.node
		}
	}
);

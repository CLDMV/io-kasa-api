import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Root Vitest config. Lives in .configs/; `root` is pinned to the repo root so
// the include globs resolve correctly regardless of this file's location.
const repoRoot = resolve(import.meta.dirname, "..");

export default defineConfig({
	root: repoRoot,
	test: {
		include: ["tests/**/*.test.vitest.mjs"],
		exclude: ["**/node_modules/**", "**/dist/**"],
		environment: "node",
		globals: false,
		pool: "forks",
		testTimeout: 30000,
		// "dot" keeps CI logs to one character per test file instead of a full
		// per-file pass/fail block; the final summary is printed either way.
		reporters: ["dot"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			// json-summary produces coverage/coverage-summary.json for the CI coverage badge.
			reporter: ["text", "html", "json-summary", "json"]
		}
	}
});

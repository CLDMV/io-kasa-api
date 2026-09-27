import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Root Vitest config. Lives in .configs/; `root` is pinned to the repo root so
// the include globs resolve correctly regardless of this file's location.
const repoRoot = resolve(import.meta.dirname, "..");

// Load .env so integration tests can reach the backing-services stack.
// Suites that need a service skip themselves when its config is absent.
const envFile = resolve(repoRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
	root: repoRoot,
	test: {
		include: ["tests/**/*.test.vitest.mjs"],
		exclude: ["**/node_modules/**", "**/dist/**", "**/.slothlet-cache/**"],
		environment: "node",
		globals: false,
		pool: "forks",
		testTimeout: 30000,
		// "dot" keeps CI logs to one character per test file instead of a full
		// per-file pass/fail block; the final summary is printed either way.
		reporters: ["dot"],
		// Load slothlet through vitest's module graph (slothlet docs/TESTING.md) so leaves it
		// loads can attribute to coverage. Note: this repo's leaves are TypeScript, which
		// slothlet transpiles with esbuild into its own cache and imports from there, so
		// src/api/** still reports 0% even though the tests exercise every module.
		server: { deps: { inline: [/@cldmv\/slothlet/] } },
		coverage: {
			provider: "v8",
			include: ["src/**"],
			// json-summary produces coverage/coverage-summary.json for the CI coverage badge.
			reporter: ["text", "html", "json-summary", "json"]
		}
	}
});

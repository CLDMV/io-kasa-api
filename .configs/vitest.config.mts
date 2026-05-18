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
	},
});

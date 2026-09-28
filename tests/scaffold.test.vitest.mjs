import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Scaffold sanity check: verifies the repository's package.json is present and
// well-formed. This is the baseline test on the v4 scaffold; real application
// tests live on the `dev` branch.
describe("scaffold", () => {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

	it("has a scoped package name", () => {
		expect(pkg.name).toBe("@cldmv/io-kasa-api");
	});

	it("is an ES module package", () => {
		expect(pkg.type).toBe("module");
	});
});

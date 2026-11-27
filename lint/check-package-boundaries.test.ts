import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOUNDARIES, boundaryViolations } from "./check-package-boundaries.ts";

/**
 * The package boundary check over a repository laid out as this one is, in
 * a directory of its own: core's sources, and the bot loop's.
 */
describe("the package boundary check", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "package-boundaries-"));
		write("packages/bot-loop/src/steps.ts", "export const steps = 1;\n");
		write("packages/core/src/chats/turns/turns.ts", "export const turns = 1;\n");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function write(path: string, text: string) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}

	it("finds core reaching the bot loop by a relative path", () => {
		write(
			"packages/core/src/chats/runner.ts",
			'import { turns } from "./turns/turns.ts";\nimport { steps } from "../../../bot-loop/src/steps.ts";\n',
		);

		expect(boundaryViolations(root)).toEqual([
			{
				file: join("packages", "core", "src", "chats", "runner.ts"),
				line: 2,
				specifier: "../../../bot-loop/src/steps.ts",
				boundary: BOUNDARIES[0],
			},
		]);
	});

	it("finds core reaching the bot loop by its name, or by a dynamic import", () => {
		write(
			"packages/core/src/chats/runner.ts",
			'export { steps } from "@sugabots/bot-loop/steps";\nconst later = () => import("../../../bot-loop/src/steps.ts");\n',
		);

		expect(boundaryViolations(root).map(({ specifier }) => specifier)).toEqual([
			"@sugabots/bot-loop/steps",
			"../../../bot-loop/src/steps.ts",
		]);
	});

	it("lets core import its own modules and other packages", () => {
		write(
			"packages/core/src/chats/runner.ts",
			'import { turns } from "./turns/turns.ts";\nimport { Effect } from "effect";\nimport { chatStream } from "@sugabots/contracts";\n',
		);

		expect(boundaryViolations(root)).toEqual([]);
	});

	it.each([
		"import(`@sugabots/bot-loop`);",
		'import(/* load only when needed */ "@sugabots/bot-loop");',
		'vi.mock("@sugabots/bot-loop");',
		'vitest.mock("@sugabots/bot-loop");',
		'import { vi as v } from "vitest"; v.mock("@sugabots/bot-loop");',
		'import { createRequire } from "node:module"; createRequire(import.meta.url)("@sugabots/bot-loop");',
		'module.require("@sugabots/bot-loop");',
		'vi.importActual<typeof import("effect")>("@sugabots/bot-loop");',
		'import.meta.resolve("@sugabots/bot-loop");',
		'require.resolve("@sugabots/bot-loop");',
		'type Steps = typeof import("@sugabots/bot-loop");',
		'import steps = require("@sugabots/bot-loop");',
	])("finds a forbidden module in %s", (source) => {
		write("packages/core/src/chats/runner.ts", source);

		expect(boundaryViolations(root).map(({ specifier }) => specifier)).toEqual([
			"@sugabots/bot-loop",
		]);
	});

	it.each([
		['import.meta.glob("../../../bot-loop/src/*.ts");', "../../../bot-loop/src/*.ts"],
		[
			'import.meta.glob(["./turns/*.ts", "!../../../bot-loop/src/*.ts", "/packages/bot-loop/src/**/*.ts"]);',
			"/packages/bot-loop/src/**/*.ts",
		],
	])("finds core reaching the bot loop in %s", (source, specifier) => {
		write("packages/core/src/chats/runner.ts", source);

		expect(boundaryViolations(root).map((violation) => violation.specifier)).toEqual([specifier]);
	});

	it("finds the forbidden package prefix in an interpolated import", () => {
		write("packages/core/src/chats/runner.ts", `import(\`@sugabots/bot-loop/\${name}\`);`);

		expect(boundaryViolations(root).map(({ specifier }) => specifier)).toEqual([
			"@sugabots/bot-loop/",
		]);
	});

	it("ignores module references inside comments and strings", () => {
		write(
			"packages/core/src/chats/runner.ts",
			'// vi.mock("@sugabots/bot-loop");\nconst example = \'import("@sugabots/bot-loop")\';\n',
		);

		expect(boundaryViolations(root)).toEqual([]);
	});

	it.each(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])(
		"finds the forbidden package in %s",
		(field) => {
			write(
				"packages/core/package.json",
				JSON.stringify({ [field]: { "@sugabots/bot-loop": "workspace:*" } }, null, 2),
			);

			expect(boundaryViolations(root)).toEqual([
				{
					file: join("packages", "core", "package.json"),
					line: 3,
					specifier: "@sugabots/bot-loop",
					boundary: BOUNDARIES[0],
				},
			]);
		},
	);
});

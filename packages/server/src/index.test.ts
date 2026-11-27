import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Vitest loads modules its own way, in an order its other tests have already
// warmed up, so a layer read before its module finished loading only shows in
// a fresh Node process, as `node src/index.ts` starts one.
const serverDirectory = fileURLToPath(new URL("..", import.meta.url));
const coreSource = new URL("../../core/src/", import.meta.url);
const botLoopSource = new URL("../../bot-loop/src/", import.meta.url);

const CHILD_TIMEOUT_MS = 60_000;

/**
 * Runs `script` as an ES module in a new Node process, from the server
 * package so `effect` resolves, and resolves with its exit code and stderr.
 * A process still running after {@link CHILD_TIMEOUT_MS}, such as one that
 * started listening, is killed and fails.
 */
const runFreshNode = (script: string) =>
	new Promise<{ exitCode: number | null; stderr: string }>((resolve) => {
		execFile(
			process.execPath,
			["--input-type=module", "--eval", script],
			{ cwd: serverDirectory, timeout: CHILD_TIMEOUT_MS },
			(error, _stdout, stderr) => {
				const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : null;
				resolve({ exitCode, stderr });
			},
		);
	});

const expectCleanExit = async (script: string) => {
	const { exitCode, stderr } = await runFreshNode(script);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
};

const importFirst = (moduleUrl: URL) => `await import(${JSON.stringify(moduleUrl.href)});`;

describe("loading the server in a fresh process", () => {
	it(
		"imports the server's main module without starting it, and its Main is a layer",
		() =>
			expectCleanExit(`
				const { Main } = await import(${JSON.stringify(new URL("index.ts", import.meta.url).href)});
				const { Layer } = await import("effect");
				if (!Layer.isLayer(Main)) throw new Error("Main is not a layer");
			`),
		CHILD_TIMEOUT_MS,
	);

	it.each([
		["Floor control", new URL("chats/floor/floor-control.ts", coreSource)],
		["Bot loop steps", new URL("steps.ts", botLoopSource)],
		["Turn tools", new URL("chats/turns/tools.ts", coreSource)],
	])(
		"%s loads without a circular-import failure",
		(_name, moduleUrl) => expectCleanExit(importFirst(moduleUrl)),
		CHILD_TIMEOUT_MS,
	);
});

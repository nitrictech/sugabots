import { Context, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { effectRunner } from "../../../database/database.ts";
import type { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import { placeOf, runCommandTool, type TurnSandbox } from "./tools.ts";

const place = placeOf({
	threadId: "0199a3a0-0000-7000-8000-000000000001",
	agentId: "0199a3a0-0000-7000-8000-000000000003",
});

describe("a sandbox tool's call", () => {
	it("stops its command when the call is aborted, as when its turn is cancelled", async () => {
		let started: () => void = () => {};
		const commandStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let commandStopped = false;
		const sandbox = {
			exec: () =>
				Effect.sync(started).pipe(
					Effect.andThen(Effect.never),
					Effect.onInterrupt(() =>
						Effect.sync(() => {
							commandStopped = true;
						}),
					),
				),
		} as Pick<Sandboxes.Sandbox, "exec"> as Sandboxes.Sandbox;
		const turnSandbox: TurnSandbox = {
			open: async () => ({ sandbox, arrival: "running" }),
			run: effectRunner<never>({ runPromiseExit: Effect.runPromiseExitWith(Context.empty()) }),
		};
		const call = new AbortController();

		const running = runCommandTool(turnSandbox, place).execute?.(
			{ command: "sleep 900", timeout_seconds: 900 },
			{ toolCallId: "call-1", messages: [], context: {}, abortSignal: call.signal },
		);
		await commandStarted;
		call.abort();

		await expect(running).rejects.toBeDefined();
		expect(commandStopped).toBe(true);
	});
});

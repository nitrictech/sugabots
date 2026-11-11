import { SANDBOX_E2B_DEFAULT_SIZE } from "@sugabots/contracts";
import { Sandbox } from "e2b";
import { Effect, Redacted, Result } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ids } from "../../ids/ids.ts";
import { fromE2b } from "./e2b.ts";

afterEach(() => vi.restoreAllMocks());

describe("E2B setup failures", () => {
	it("destroys a sandbox it made when readying it for agents fails", async () => {
		const setupFailure = new Error("command failed");
		vi.spyOn(Sandbox, "create").mockResolvedValue({
			sandboxId: "made-sandbox",
			commands: { run: vi.fn().mockRejectedValue(setupFailure) },
		} as unknown as Sandbox);
		const kill = vi.spyOn(Sandbox, "kill").mockResolvedValue(true);
		const provider = fromE2b(
			{
				provider: "e2b",
				apiKey: Redacted.make("test-key"),
				template: "test-template",
				size: SANDBOX_E2B_DEFAULT_SIZE,
				networkMode: "allowlist",
			},
			await Effect.runPromise(Ids.make),
		);
		const result = await Effect.runPromise(
			Effect.result(
				provider.create({
					labels: {},
					reach: { kind: "open", blockedHosts: [] },
					workName: "test",
				}),
			),
		);
		expect(Result.isFailure(result)).toBe(true);
		if (!Result.isFailure(result)) return;
		expect(result.failure.cause).toBe(setupFailure);
		expect(kill).toHaveBeenCalledWith("made-sandbox", expect.anything());
	});
});

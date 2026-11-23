import { Sandbox, SandboxApiException } from "@alibaba-group/opensandbox";
import { COMPUTER_OPENSANDBOX_DEFAULT_SIZE } from "@sugabots/contracts";
import { Effect, Redacted, Result } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ids } from "../../ids/ids.ts";
import { fromOpenSandbox } from "./opensandbox.ts";

afterEach(() => vi.restoreAllMocks());

const createComputer = async () => {
	const provider = fromOpenSandbox(
		{
			provider: "opensandbox",
			baseUrl: "http://localhost:8090",
			apiKey: Redacted.make("test-key"),
			image: "example/image:latest",
			size: COMPUTER_OPENSANDBOX_DEFAULT_SIZE,
			networkMode: "allowed-hosts-only",
		},
		await Effect.runPromise(Ids.make),
	);
	return Effect.runPromise(
		Effect.result(
			provider.create({
				labels: {},
				reach: { kind: "open", blockedHosts: [] },
				workName: "test",
			}),
		),
	);
};

describe("OpenSandbox creation failures", () => {
	it.each([400, 429, 500, 503])(
		"names the image without diagnosing an HTTP %i response as an image error",
		async (statusCode) => {
			const cause = new SandboxApiException({ statusCode, message: "Creation failed" });
			vi.spyOn(Sandbox, "create").mockRejectedValue(cause);
			const result = await createComputer();
			expect(Result.isFailure(result)).toBe(true);
			if (!Result.isFailure(result)) return;
			expect(result.failure.cause).toBe(cause);
			expect(result.failure.userMessage).toBe(
				"OpenSandbox couldn't create a computer using image example/image:latest. Check the OpenSandbox server logs for the cause.",
			);
		},
	);

	it("destroys a computer whose setup fails, and reports the setup's failure even when destroying fails", async () => {
		const kill = vi.fn().mockRejectedValue(new Error("Kill failed"));
		vi.spyOn(Sandbox, "create").mockResolvedValue({
			commands: {
				run: async () => ({ exitCode: 127, logs: { stderr: [{ text: "groupadd: not found" }] } }),
			},
			kill,
		} as unknown as Sandbox);
		const result = await createComputer();
		expect(kill).toHaveBeenCalledOnce();
		expect(Result.isFailure(result)).toBe(true);
		if (!Result.isFailure(result)) return;
		expect(String(result.failure.cause)).toContain("groupadd: not found");
	});
});

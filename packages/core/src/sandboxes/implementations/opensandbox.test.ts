import { Sandbox, SandboxApiException } from "@alibaba-group/opensandbox";
import { SANDBOX_DEFAULT_SIZE } from "@sugabots/contracts";
import { Effect, Redacted, Result } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ids } from "../../ids/ids.ts";
import { fromOpenSandbox } from "./opensandbox.ts";

afterEach(() => vi.restoreAllMocks());

describe("OpenSandbox creation failures", () => {
	it.each([400, 429, 500, 503])(
		"names the image without diagnosing an HTTP %i response as an image error",
		async (statusCode) => {
			const cause = new SandboxApiException({ statusCode, message: "Creation failed" });
			vi.spyOn(Sandbox, "create").mockRejectedValue(cause);
			const provider = fromOpenSandbox(
				{
					provider: "opensandbox",
					baseUrl: "http://localhost:8090",
					apiKey: Redacted.make("test-key"),
					image: "example/image:latest",
					size: SANDBOX_DEFAULT_SIZE,
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
			expect(result.failure.cause).toBe(cause);
			expect(result.failure.userMessage).toBe(
				"OpenSandbox couldn't create a sandbox using image example/image:latest. Check the OpenSandbox server logs for the cause.",
			);
		},
	);
});

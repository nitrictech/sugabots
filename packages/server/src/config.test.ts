import { Cause, ConfigProvider, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "./config.ts";

describe("ServerConfig.layer", () => {
	it.each(["0", "65536", "3000.5", "not-a-port"])('refuses PORT "%s"', async (port) => {
		const exit = await Effect.runPromiseExit(
			ServerConfig.Service.pipe(
				Effect.provide(ServerConfig.layer),
				Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { PORT: port } }))),
			),
		);

		expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "started").toMatch(/PORT/);
	});
});

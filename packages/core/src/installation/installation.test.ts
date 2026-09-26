import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { Installation } from "./installation.ts";

function installationFor(env: Record<string, string>) {
	return Effect.runPromiseExit(
		Installation.Service.pipe(
			Effect.provide(
				Installation.layer.pipe(
					Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
				),
			),
		),
	);
}

describe("Installation.layer", () => {
	it("is a development installation on its own port unless told otherwise", async () => {
		expect(await installationFor({ PORT: "4000" })).toMatchObject({
			_tag: "Success",
			value: {
				isProduction: false,
				publicUrl: "http://localhost:4000",
				webAppUrl: "http://localhost:4000",
				trustedOrigins: ["http://localhost:4000"],
			},
		});
	});

	it("serves the web app apart from the API when WEB_APP_URL is set", async () => {
		expect(
			await installationFor({
				NODE_ENV: "production",
				PUBLIC_URL: "https://api.example.com/",
				WEB_APP_URL: "https://app.example.com/",
			}),
		).toMatchObject({
			_tag: "Success",
			value: {
				isProduction: true,
				publicUrl: "https://api.example.com",
				webAppUrl: "https://app.example.com",
				trustedOrigins: ["https://api.example.com", "https://app.example.com"],
			},
		});
	});

	it("runs a test runner's NODE_ENV as development", async () => {
		expect(await installationFor({ NODE_ENV: "test" })).toMatchObject({
			_tag: "Success",
			value: { isProduction: false },
		});
	});

	it.each([
		[
			"an unknown NODE_ENV",
			{ NODE_ENV: "prod" },
			/NODE_ENV must be development, production or test/,
		],
		["a PUBLIC_URL that is not a URL", { PUBLIC_URL: "sugabots.example.com" }, /PUBLIC_URL/],
		[
			"a WEB_APP_URL that is not HTTP",
			{ WEB_APP_URL: "ftp://app.example.com" },
			/WEB_APP_URL must use HTTP/,
		],
	])("refuses to start with %s", async (_, env, message) => {
		const exit = await installationFor(env);

		expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toMatch(message);
	});
});

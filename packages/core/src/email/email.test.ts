import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import { type Email, EmailService, parseEmailAddress } from "./email.ts";

const email: Email = {
	from: { email: "sugabots@example.com" },
	to: [{ email: "person@example.com" }],
	subject: "Invitation",
	text: "Open this link",
};

/** Sends `email` through `EmailService.layerNoDeps` as configured by `env`, recording HTTP requests. */
async function sendWith(env: Record<string, string>) {
	const requests: HttpClientRequest.HttpClientRequest[] = [];
	const http = HttpClient.make((request) =>
		Effect.sync(() => {
			requests.push(request);
			return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
		}),
	);
	const exit = await Effect.runPromiseExit(
		Effect.flatMap(EmailService, (service) => service.send(email)).pipe(
			Effect.provide(
				EmailService.layerNoDeps.pipe(
					Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
					Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
				),
			),
		),
	);
	return { exit, requests };
}

function failureMessage(exit: Exit.Exit<unknown, unknown>) {
	if (Exit.isSuccess(exit)) return undefined;
	const error = Cause.findErrorOption(exit.cause);
	return error._tag === "Some" ? (error.value as { message?: string }).message : undefined;
}

describe("EmailService.layerNoDeps", () => {
	it("prints to the console in development when no provider is set", async () => {
		const { exit, requests } = await sendWith({});

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(requests).toHaveLength(0);
	});

	it("uses the console in production when no provider is set", async () => {
		const { exit, requests } = await sendWith({ NODE_ENV: "production" });

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(requests).toHaveLength(0);
	});

	it("sends through the webhook when EMAIL_PROVIDER is webhook", async () => {
		const { exit, requests } = await sendWith({
			NODE_ENV: "production",
			EMAIL_PROVIDER: "webhook",
			EMAIL_WEBHOOK_URL: "https://mailer.example.com/sugabots",
			EMAIL_WEBHOOK_TOKEN: "secret",
		});

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(requests[0]?.url).toBe("https://mailer.example.com/sugabots");
		expect(requests[0]?.headers.authorization).toBe("Bearer secret");
	});

	it("refuses an insecure webhook in production", async () => {
		const { exit } = await sendWith({
			NODE_ENV: "production",
			EMAIL_PROVIDER: "webhook",
			EMAIL_WEBHOOK_URL: "http://mailer.example.com/sugabots",
		});

		expect(failureMessage(exit)).toMatch(/must use HTTPS in production/);
	});

	it("refuses a webhook that is not HTTP", async () => {
		const { exit } = await sendWith({
			EMAIL_PROVIDER: "webhook",
			EMAIL_WEBHOOK_URL: "ftp://mailer.example.com/sugabots",
		});

		expect(failureMessage(exit)).toMatch(/must use HTTP or HTTPS/);
	});
});

describe("EmailService.layerNoDeps provider selection", () => {
	it("uses the console when EMAIL_PROVIDER is unset, even with webhook settings", async () => {
		const { exit, requests } = await sendWith({
			EMAIL_WEBHOOK_URL: "https://mailer.example.com/sugabots",
		});

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(requests).toHaveLength(0);
	});

	it("requires EMAIL_WEBHOOK_URL for the webhook", async () => {
		const { exit } = await sendWith({ EMAIL_PROVIDER: "webhook" });

		expect(Exit.isFailure(exit)).toBe(true);
		expect(failureDescription(exit)).toMatch(/EMAIL_WEBHOOK_URL/);
	});

	it("refuses a provider it does not know", async () => {
		const { exit } = await sendWith({ EMAIL_PROVIDER: "carrier-pigeon" });

		expect(Exit.isFailure(exit)).toBe(true);
		expect(failureDescription(exit)).toMatch(/EMAIL_PROVIDER/);
	});
});

/** The failure's full description, for settings errors Effect reports itself. */
function failureDescription(exit: Exit.Exit<unknown, unknown>) {
	return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
}

describe("parseEmailAddress", () => {
	it("reads a named address", () => {
		expect(parseEmailAddress("Sugabots <no-reply@example.com>")).toEqual({
			email: "no-reply@example.com",
			name: "Sugabots",
		});
	});

	it("reads a quoted name", () => {
		expect(parseEmailAddress('"Sugabots, Inc" <no-reply@example.com>')).toEqual({
			email: "no-reply@example.com",
			name: "Sugabots, Inc",
		});
	});

	it("reads a bare address", () => {
		expect(parseEmailAddress(" no-reply@example.com ")).toEqual({ email: "no-reply@example.com" });
	});

	it("rejects anything else", () => {
		expect(parseEmailAddress("Sugabots")).toBeUndefined();
		expect(parseEmailAddress("Sugabots <not-an-address>")).toBeUndefined();
	});
});

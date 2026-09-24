import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import { type Email, EmailService, parseEmailAddress } from "./email.ts";

const email: Email = {
	from: { email: "sugabots@example.com", name: "Sugabots" },
	to: [{ email: "person@example.com" }],
	subject: "Invitation",
	text: "Open this link",
};

const webhook = {
	EMAIL_PROVIDER: "webhook",
	EMAIL_WEBHOOK_URL: "https://mailer.example.com/sugabots",
};

/**
 * Sends `email` through `EmailService.layerNoDeps` as `env` configures it, over
 * an HTTP client that records each request and answers `status`.
 */
async function sendWith(env: Record<string, string>, status = 204) {
	const requests: HttpClientRequest.HttpClientRequest[] = [];
	const http = HttpClient.make((request) =>
		Effect.sync(() => {
			requests.push(request);
			return HttpClientResponse.fromWeb(request, new Response(null, { status }));
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
	return { exit, requests, failure: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined };
}

function jsonBody(request: HttpClientRequest.HttpClientRequest | undefined) {
	if (request?.body._tag !== "Uint8Array") throw new Error("expected a JSON body");
	return JSON.parse(new TextDecoder().decode(request.body.body));
}

describe("EmailService.layerNoDeps", () => {
	it.each([
		["with nothing set", {}],
		["in production", { NODE_ENV: "production" }],
		["when only webhook settings are set", { EMAIL_WEBHOOK_URL: webhook.EMAIL_WEBHOOK_URL }],
	])("prints to the console %s", async (_, env) => {
		const { exit, requests } = await sendWith(env);

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(requests).toHaveLength(0);
	});

	it("posts the email as JSON to the webhook with bearer authentication", async () => {
		const { exit, requests } = await sendWith({ ...webhook, EMAIL_WEBHOOK_TOKEN: "secret" });

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.url).toBe(webhook.EMAIL_WEBHOOK_URL);
		expect(requests[0]?.headers.authorization).toBe("Bearer secret");
		expect(jsonBody(requests[0])).toEqual(email);
	});

	it("sends no authorization header without a token", async () => {
		const { requests } = await sendWith(webhook);

		expect(requests[0]?.headers.authorization).toBeUndefined();
	});

	it("fails with EmailDeliveryFailed when the webhook rejects the email", async () => {
		const { exit } = await sendWith(webhook, 503);

		expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toMatchObject({
			_tag: "Some",
			value: { _tag: "EmailDeliveryFailed", provider: "webhook" },
		});
	});

	it.each([
		[
			"an insecure webhook in production",
			{ ...webhook, NODE_ENV: "production", EMAIL_WEBHOOK_URL: "http://mailer.example.com" },
			/must use HTTPS in production/,
		],
		[
			"a webhook that is not HTTP",
			{ ...webhook, EMAIL_WEBHOOK_URL: "ftp://mailer.example.com" },
			/must use HTTP or HTTPS/,
		],
		["the webhook without EMAIL_WEBHOOK_URL", { EMAIL_PROVIDER: "webhook" }, /EMAIL_WEBHOOK_URL/],
		["a provider it does not know", { EMAIL_PROVIDER: "carrier-pigeon" }, /EMAIL_PROVIDER/],
	])("refuses %s", async (_, env, message) => {
		const { failure } = await sendWith(env);

		expect(failure).toMatch(message);
	});
});

describe("parseEmailAddress", () => {
	it.each([
		["Sugabots <no-reply@example.com>", { email: "no-reply@example.com", name: "Sugabots" }],
		[
			'"Sugabots, Inc" <no-reply@example.com>',
			{ email: "no-reply@example.com", name: "Sugabots, Inc" },
		],
		[" no-reply@example.com ", { email: "no-reply@example.com" }],
		["Sugabots", undefined],
		["Sugabots <not-an-address>", undefined],
	])("parses %j", (value, expected) => {
		expect(parseEmailAddress(value)).toEqual(expected);
	});
});

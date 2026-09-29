import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import { Installation } from "../installation/installation.ts";
import { Email } from "./email.ts";

const message: Email.Message = {
	from: { email: "sugabots@example.com", name: "Sugabots" },
	to: [{ email: "person@example.com" }],
	subject: "Invitation",
	text: "Open this link",
};

const webhook = {
	EMAIL_PROVIDER: "webhook",
	EMAIL_WEBHOOK_URL: "https://mailer.example.com/sugabots",
};

const resend = { EMAIL_PROVIDER: "resend", EMAIL_RESEND_API_KEY: "re_secret" };

async function sendWith(env: Record<string, string>, status = 204, sent = message) {
	const requests: HttpClientRequest.HttpClientRequest[] = [];
	const http = HttpClient.make((request) =>
		Effect.sync(() => {
			requests.push(request);
			return HttpClientResponse.fromWeb(request, new Response(null, { status }));
		}),
	);
	const exit = await Effect.runPromiseExit(
		Effect.flatMap(Email.Service, (email) => email.send(sent)).pipe(
			Effect.provide(
				Email.layerNoDeps.pipe(
					Layer.provide([Layer.succeed(HttpClient.HttpClient, http), Installation.layer]),
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

describe("Email.layerNoDeps", () => {
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
		expect(jsonBody(requests[0])).toEqual(message);
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

	it("sends the email to Resend with the API key", async () => {
		const { exit, requests } = await sendWith(resend, 200);

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(requests[0]?.url).toBe("https://api.resend.com/emails");
		expect(requests[0]?.headers.authorization).toBe("Bearer re_secret");
		expect(jsonBody(requests[0])).toEqual({
			from: '"Sugabots" <sugabots@example.com>',
			to: ["person@example.com"],
			subject: "Invitation",
			text: "Open this link",
		});
	});

	it("gives Resend every recipient, keeping a name with a comma or quote whole", async () => {
		const { requests } = await sendWith(resend, 200, {
			...message,
			from: { email: "sugabots@example.com", name: 'Sugabots, "Inc"' },
			cc: [{ email: "lead@example.com", name: "Lead" }],
			bcc: [{ email: "audit@example.com" }],
			replyTo: { email: "support@example.com" },
		});

		expect(jsonBody(requests[0])).toMatchObject({
			from: '"Sugabots, \\"Inc\\"" <sugabots@example.com>',
			cc: ['"Lead" <lead@example.com>'],
			bcc: ["audit@example.com"],
			reply_to: "support@example.com",
		});
	});

	it("fails with EmailDeliveryFailed when Resend rejects the email", async () => {
		const { exit } = await sendWith(resend, 422);

		expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toMatchObject({
			_tag: "Some",
			value: { _tag: "EmailDeliveryFailed", provider: "resend" },
		});
	});

	it.each([
		["Resend without EMAIL_RESEND_API_KEY", { EMAIL_PROVIDER: "resend" }, /EMAIL_RESEND_API_KEY/],
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

describe("Email.parseAddress", () => {
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
		expect(Email.parseAddress(value)).toEqual(expected);
	});
});

describe("Email.transactionalSender", () => {
	function senderFor(env: Record<string, string>) {
		return Effect.runPromiseExit(
			Email.transactionalSender.pipe(
				Effect.provide(Installation.layer),
				Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
			),
		);
	}

	it("sends from a local address in development", async () => {
		expect(await senderFor({})).toEqual(
			Exit.succeed({ email: "sugabots@localhost", name: "Sugabots" }),
		);
	});

	it("is required in production", async () => {
		const exit = await senderFor({ NODE_ENV: "production" });

		expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toMatch(
			/EMAIL_TRANSACTIONAL_FROM is required in production/,
		);
	});

	it("reads a named address", async () => {
		expect(
			await senderFor({ EMAIL_TRANSACTIONAL_FROM: "Sugabots <no-reply@example.com>" }),
		).toEqual(Exit.succeed({ email: "no-reply@example.com", name: "Sugabots" }));
	});

	it("refuses a value that is not an address", async () => {
		const exit = await senderFor({ EMAIL_TRANSACTIONAL_FROM: "Sugabots" });

		expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toMatch(
			/EMAIL_TRANSACTIONAL_FROM must be an address/,
		);
	});
});

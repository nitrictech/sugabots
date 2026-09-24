import { Cause, Effect, Exit, Layer, Redacted } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import { type Email, EmailService } from "../email.ts";

const email: Email = {
	from: { email: "sugabots@example.com", name: "Sugabots" },
	to: [{ email: "person@example.com" }],
	subject: "Invitation",
	text: "Open this link",
};

/** Sends `email` through the webhook implementation, over an HTTP client that answers `status`. */
async function sendOver(status: number, token?: string) {
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
				EmailService.fromWebhook({
					url: "https://mailer.example.com/sugabots",
					token: token === undefined ? undefined : Redacted.make(token),
				}).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
			),
		),
	);
	return { exit, requests };
}

function jsonBody(request: HttpClientRequest.HttpClientRequest) {
	if (request.body._tag !== "Uint8Array")
		throw new Error(`expected a JSON body, got ${request.body._tag}`);
	return JSON.parse(new TextDecoder().decode(request.body.body));
}

describe("EmailService.fromWebhook", () => {
	it("posts the email as JSON with bearer authentication", async () => {
		const { exit, requests } = await sendOver(204, "secret");

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request?.method).toBe("POST");
		expect(request?.url).toBe("https://mailer.example.com/sugabots");
		expect(request?.headers.authorization).toBe("Bearer secret");
		expect(request && jsonBody(request)).toEqual(email);
	});

	it("sends no authorization header without a token", async () => {
		const { requests } = await sendOver(204);

		expect(requests[0]?.headers.authorization).toBeUndefined();
	});

	it("fails with EmailDeliveryFailed when the webhook rejects the email", async () => {
		const { exit } = await sendOver(503);

		expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toMatchObject({
			_tag: "Some",
			value: { _tag: "EmailDeliveryFailed", provider: "webhook" },
		});
	});
});

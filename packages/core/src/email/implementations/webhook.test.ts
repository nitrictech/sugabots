import { Cause, Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type Email, EmailService } from "../email.ts";

const email: Email = {
	from: { email: "sugabots@example.com", name: "Sugabots" },
	to: [{ email: "person@example.com" }],
	subject: "Invitation",
	text: "Open this link",
};

function send(fetch: typeof globalThis.fetch, token?: string) {
	return Effect.runPromiseExit(
		Effect.flatMap(EmailService, (service) => service.send(email)).pipe(
			Effect.provide(
				EmailService.fromWebhook(
					{ provider: "webhook", url: "https://mailer.example.com/sugabots", token },
					fetch,
				),
			),
		),
	);
}

describe("EmailService.fromWebhook", () => {
	it("posts the email with bearer authentication", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response(null, { status: 204 }));

		expect(Exit.isSuccess(await send(fetch, "secret"))).toBe(true);
		expect(fetch).toHaveBeenCalledWith(
			"https://mailer.example.com/sugabots",
			expect.objectContaining({
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer secret",
				},
				body: JSON.stringify(email),
			}),
		);
	});

	it("fails when the webhook rejects the email", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response(null, { status: 503, statusText: "Unavailable" }));

		const exit = await send(fetch);

		expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toMatchObject({
			_tag: "Some",
			value: { _tag: "EmailDeliveryFailed", provider: "webhook" },
		});
	});
});

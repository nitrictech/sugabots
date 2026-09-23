import { describe, expect, it, vi } from "vitest";
import { webhookMailer } from "./mailer.ts";

describe("webhookMailer", () => {
	it("posts the email with bearer authentication", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response(null, { status: 204 }));
		const send = webhookMailer("https://mailer.example.com/sugabots", "secret", fetch);

		await send({ to: "person@example.com", subject: "Invitation", text: "Open this link" });

		expect(fetch).toHaveBeenCalledWith(
			"https://mailer.example.com/sugabots",
			expect.objectContaining({
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer secret",
				},
				body: JSON.stringify({
					to: "person@example.com",
					subject: "Invitation",
					text: "Open this link",
				}),
			}),
		);
	});

	it("rejects failed delivery", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response(null, { status: 503, statusText: "Unavailable" }));

		await expect(
			webhookMailer(
				"https://mailer.example.com/sugabots",
				undefined,
				fetch,
			)({
				to: "person@example.com",
				subject: "Invitation",
				text: "Open this link",
			}),
		).rejects.toThrow("Email webhook returned 503 Unavailable");
	});
});

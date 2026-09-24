import { Effect } from "effect";
// email.ts imports this module, so its values are only used inside `send`, after
// both modules have loaded.
import { EmailDeliveryFailed, type EmailService } from "../email.ts";

export interface WebhookEmailConfig {
	provider: "webhook";
	/** Receives each email as a JSON `POST` of its `Email`. */
	url: string;
	/** Sent as a bearer token when present. */
	token?: string;
}

const TIMEOUT_MS = 15_000;

export const webhook = (
	config: WebhookEmailConfig,
	fetch = globalThis.fetch,
): EmailService["Service"] => ({
	send: (email) =>
		Effect.tryPromise({
			try: async () => {
				const response = await fetch(config.url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
					},
					body: JSON.stringify(email),
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
				if (!response.ok) {
					throw new Error(`Email webhook returned ${response.status} ${response.statusText}`);
				}
			},
			catch: (cause) => new EmailDeliveryFailed({ provider: "webhook", cause }),
		}),
});

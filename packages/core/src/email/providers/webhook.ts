import { Effect, Layer } from "effect";
import { EmailDeliveryFailed, EmailService } from "../email.ts";

export interface WebhookEmailConfig {
	provider: "webhook";
	/** Receives each email as a JSON `POST` of its `Email`. */
	url: string;
	/** Sent as a bearer token when present. */
	token?: string;
}

const TIMEOUT_MS = 15_000;

/** Posts each email to `config.url`, for a relay the installation runs itself. */
export const webhookEmailLayer = (config: WebhookEmailConfig, fetch = globalThis.fetch) =>
	Layer.succeed(
		EmailService,
		EmailService.of({
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
		}),
	);

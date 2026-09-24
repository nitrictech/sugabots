import { Duration, Effect, identity, type Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
// email.ts imports this module, so its values are only used inside `send`, after
// both modules have loaded.
import { type Email, EmailDeliveryFailed } from "../email.ts";

export interface WebhookEmailConfig {
	/** Receives each email as a JSON `POST` of its `Email`. */
	url: string;
	/** Sent as a bearer token when present. */
	token?: Redacted.Redacted;
}

const TIMEOUT = Duration.seconds(15);

// Typed through `Email` rather than `EmailService["Service"]`: EmailService's
// `make` returns this, so naming the service type here would be circular.
export const fromWebhook = (config: WebhookEmailConfig) =>
	Effect.map(HttpClient.HttpClient, (client) => {
		const http = HttpClient.filterStatusOk(client);
		return {
			send: (email: Email): Effect.Effect<void, EmailDeliveryFailed> =>
				HttpClientRequest.post(config.url).pipe(
					config.token ? HttpClientRequest.bearerToken(config.token) : identity,
					HttpClientRequest.bodyJsonUnsafe(email),
					http.execute,
					Effect.timeout(TIMEOUT),
					Effect.asVoid,
					Effect.mapError((cause) => new EmailDeliveryFailed({ provider: "webhook", cause })),
				),
		};
	});

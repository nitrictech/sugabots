import { Duration, Effect, identity, type Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
// email.ts imports this module, so its values are only used inside `send`, after
// both modules have loaded.
import { EmailDeliveryFailed, type EmailService } from "../email.ts";

export interface WebhookEmailConfig {
	/** Receives each email as a JSON `POST` of its `Email`. */
	url: string;
	/** Sent as a bearer token when present. */
	token?: Redacted.Redacted;
}

const TIMEOUT = Duration.seconds(15);

export const fromWebhook = (config: WebhookEmailConfig) =>
	Effect.map(HttpClient.HttpClient, (client): EmailService["Service"] => {
		const http = HttpClient.filterStatusOk(client);
		return {
			send: (email) =>
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

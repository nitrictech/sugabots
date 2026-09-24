import { Duration, Effect, identity, type Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { type Email, EmailDeliveryFailed } from "../email.ts";

export interface WebhookEmailConfig {
	url: string;
	token?: Redacted.Redacted;
}

const TIMEOUT = Duration.seconds(15);

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

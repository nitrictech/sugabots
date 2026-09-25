import { Duration, Effect, identity, type Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Email } from "../email.ts";

export interface WebhookConfig {
	url: string;
	token?: Redacted.Redacted;
}

const TIMEOUT = Duration.seconds(15);

export const fromWebhook = (config: WebhookConfig) =>
	Effect.map(HttpClient.HttpClient, (client): Email.Interface => {
		const http = HttpClient.filterStatusOk(client);
		return {
			send: (message) =>
				HttpClientRequest.post(config.url).pipe(
					config.token ? HttpClientRequest.bearerToken(config.token) : identity,
					HttpClientRequest.bodyJsonUnsafe(message),
					http.execute,
					Effect.timeout(TIMEOUT),
					Effect.asVoid,
					Effect.mapError((cause) => new Email.DeliveryFailed({ provider: "webhook", cause })),
				),
		};
	});

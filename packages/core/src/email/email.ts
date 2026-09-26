export * as Email from "./email.ts";

import { Config, Context, Data, Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Installation } from "../installation/installation.ts";
import { fromConsole } from "./implementations/console.ts";
import { fromWebhook, type WebhookConfig } from "./implementations/webhook.ts";

export interface Interface {
	readonly send: (message: Message) => Effect.Effect<void, DeliveryFailed>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Email") {}

/** Select the implementation using `EMAIL_PROVIDER`, defaults to the console. */
export const make = Effect.gen(function* () {
	const provider = yield* Config.Literals(PROVIDERS, "EMAIL_PROVIDER").pipe(
		Config.withDefault("console"),
	);
	switch (provider) {
		case "console":
			return fromConsole;
		case "webhook":
			return yield* fromWebhook(yield* webhookConfigFromEnv());
	}
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([FetchHttpClient.layer, Installation.layer]));

export interface Address {
	email: string;
	name?: string;
}

export type Body = { text: string; html?: string } | { html: string; text?: string };

export type Message = Body & {
	from: Address;
	to: readonly [Address, ...Address[]];
	cc?: readonly Address[];
	bcc?: readonly Address[];
	replyTo?: Address;
	subject: string;
};

export class DeliveryFailed extends Data.TaggedError("EmailDeliveryFailed")<{
	provider: string;
	cause: unknown;
}> {}

export class InvalidConfig extends Data.TaggedError("InvalidEmailConfig")<{
	message: string;
}> {}

/**
 * Parses `Name <address>` or a bare `address`, the forms mail clients show, or
 * returns `undefined` for anything else.
 */
export function parseAddress(value: string): Address | undefined {
	const named = /^\s*"?([^"<]*?)"?\s*<([^<>\s@]+@[^<>\s@]+)>\s*$/.exec(value);
	if (named?.[2]) return named[1] ? { email: named[2], name: named[1] } : { email: named[2] };
	const bare = value.trim();
	return /^[^<>\s@]+@[^<>\s@]+$/.test(bare) ? { email: bare } : undefined;
}

const PROVIDERS = ["console", "webhook"] as const;

function webhookConfigFromEnv() {
	return Effect.gen(function* () {
		const installation = yield* Installation.Service;
		const url = yield* Config.URL("EMAIL_WEBHOOK_URL");
		const token = yield* Config.option(Config.Redacted("EMAIL_WEBHOOK_TOKEN"));
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return yield* new InvalidConfig({ message: "EMAIL_WEBHOOK_URL must use HTTP or HTTPS" });
		}
		if (installation.isProduction && url.protocol !== "https:") {
			return yield* new InvalidConfig({
				message: "EMAIL_WEBHOOK_URL must use HTTPS in production",
			});
		}
		return { url: url.href, token: Option.getOrUndefined(token) } satisfies WebhookConfig;
	});
}

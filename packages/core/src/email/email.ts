export * as Email from "./email.ts";

import { Config, Context, Data, Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Installation } from "../installation/installation.ts";
import { fromConsole } from "./implementations/console.ts";
import { fromResend } from "./implementations/resend.ts";
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
			return yield* fromWebhook(yield* webhookConfig);
		case "resend":
			return yield* fromResend(yield* Config.Redacted("EMAIL_RESEND_API_KEY"));
	}
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer));

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

/**
 * `EMAIL_TRANSACTIONAL_FROM`, the sender of mail a person's own action triggers.
 * Required in production, where providers send only from verified addresses.
 */
export const transactionalSender = Effect.gen(function* () {
	const installation = yield* Installation.Service;
	const value = yield* Config.option(Config.String("EMAIL_TRANSACTIONAL_FROM"));
	if (Option.isNone(value)) {
		if (installation.isProduction) {
			return yield* new InvalidConfig({
				message: "EMAIL_TRANSACTIONAL_FROM is required in production.",
			});
		}
		return DEVELOPMENT_TRANSACTIONAL_SENDER;
	}
	const address = parseAddress(value.value);
	if (!address) {
		return yield* new InvalidConfig({
			message:
				"EMAIL_TRANSACTIONAL_FROM must be an address, like `Sugabots <no-reply@example.com>`.",
		});
	}
	return address;
});

const DEVELOPMENT_TRANSACTIONAL_SENDER: Address = { email: "sugabots@localhost", name: "Sugabots" };

const PROVIDERS = ["console", "webhook", "resend"] as const;

/** The webhook's settings, `EMAIL_WEBHOOK_URL` and `EMAIL_WEBHOOK_TOKEN`. Production requires HTTPS. */
const webhookConfig = Effect.gen(function* () {
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

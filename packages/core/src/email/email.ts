export * as Email from "./email.ts";

import { type DomainError, userText } from "@sugabots/errors";
import { Config, Context, Effect, ErrorReporter, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ServerSettings } from "../server-settings/server-settings.ts";
import { processLayer, Tier } from "../tiers.ts";
import { fromConsole } from "./implementations/console.ts";
import { fromResend } from "./implementations/resend.ts";
import { fromWebhook, type WebhookConfig } from "./implementations/webhook.ts";

export interface Interface {
	readonly send: (message: Message) => Effect.Effect<void, DeliveryFailed>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Email") {
	declare readonly [Tier]: "process";
}

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

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer));

export interface Address {
	email: string;
	name?: string;
}

type Body = { text: string; html?: string } | { html: string; text?: string };

export type Message = Body & {
	from: Address;
	to: readonly [Address, ...Address[]];
	replyTo?: Address;
	subject: string;
};

export class DeliveryFailed
	extends Schema.TaggedError<DeliveryFailed>()("EmailDeliveryFailed", {
		provider: Schema.String,
		cause: Schema.Defect(),
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The ${this.provider} email provider failed`;
	}
	get userMessage() {
		return userText`Sugabots couldn't send the email. Try again shortly.`;
	}
}

export class InvalidConfig
	extends Schema.TaggedError<InvalidConfig>()("InvalidEmailConfig", { message: Schema.String })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	get userMessage() {
		return userText`Email is unavailable. Ask whoever runs this server to check its email settings.`;
	}
}

/**
 * Parses `Name <address>` or a bare `address`, the forms mail clients show, or
 * returns `undefined` for anything else.
 */
function parseAddress(value: string): Address | undefined {
	const named = /^\s*"?([^"<]*?)"?\s*<([^<>\s@]+@[^<>\s@]+)>\s*$/.exec(value);
	if (named?.[2]) return named[1] ? { email: named[2], name: named[1] } : { email: named[2] };
	const bare = value.trim();
	return /^[^<>\s@]+@[^<>\s@]+$/.test(bare) ? { email: bare } : undefined;
}

/**
 * `EMAIL_TRANSACTIONAL_FROM`, the sender of mail a member's own action triggers.
 * Required in production, where providers send only from verified addresses.
 */
export const transactionalSender = Effect.gen(function* () {
	const serverSettings = yield* ServerSettings.Service;
	const value = yield* Config.option(Config.String("EMAIL_TRANSACTIONAL_FROM"));
	if (Option.isNone(value)) {
		if (serverSettings.isProduction) {
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
	const serverSettings = yield* ServerSettings.Service;
	const url = yield* Config.URL("EMAIL_WEBHOOK_URL");
	const token = yield* Config.option(Config.Redacted("EMAIL_WEBHOOK_TOKEN"));
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return yield* new InvalidConfig({ message: "EMAIL_WEBHOOK_URL must use HTTP or HTTPS" });
	}
	if (serverSettings.isProduction && url.protocol !== "https:") {
		return yield* new InvalidConfig({
			message: "EMAIL_WEBHOOK_URL must use HTTPS in production",
		});
	}
	return { url: url.href, token: Option.getOrUndefined(token) } satisfies WebhookConfig;
});

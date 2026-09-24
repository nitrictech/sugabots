import { Config, Context, Data, Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { fromConsole } from "./implementations/console.ts";
import { fromWebhook, type WebhookEmailConfig } from "./implementations/webhook.ts";

/** Sends email through the implementation the installation is configured with. */
export class EmailService extends Context.Service<
	EmailService,
	{
		readonly send: (email: Email) => Effect.Effect<void, EmailDeliveryFailed>;
	}
>()("@sugabots/core/EmailService", {
	make: Effect.gen(function* () {
		const provider = yield* Config.Literals(EMAIL_PROVIDERS, "EMAIL_PROVIDER").pipe(
			Config.withDefault("console"),
		);
		switch (provider) {
			case "console":
				return fromConsole;
			case "webhook":
				return yield* fromWebhook(yield* webhookConfigFromEnv());
		}
	}),
}) {
	static readonly layerNoDeps = Layer.effect(this, this.make);

	static readonly layer = this.layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer));
}

/** The environment asks for email that cannot be sent as configured. */
export class InvalidEmailConfig extends Data.TaggedError("InvalidEmailConfig")<{
	message: string;
}> {}

export interface EmailAddress {
	email: string;
	/** Shown instead of `email` by mail clients that support it. */
	name?: string;
}

/** An email's body: plain text, HTML, or both for clients to choose between. */
export type EmailBody = { text: string; html?: string } | { html: string; text?: string };

export type Email = EmailBody & {
	from: EmailAddress;
	to: readonly [EmailAddress, ...EmailAddress[]];
	cc?: readonly EmailAddress[];
	bcc?: readonly EmailAddress[];
	replyTo?: EmailAddress;
	subject: string;
};

/** The configured provider did not accept an email. */
export class EmailDeliveryFailed extends Data.TaggedError("EmailDeliveryFailed")<{
	provider: string;
	cause: unknown;
}> {}

/**
 * Parses `Name <address>` or a bare `address`, the forms mail clients show, or
 * returns `undefined` for anything else.
 */
export function parseEmailAddress(value: string): EmailAddress | undefined {
	const named = /^\s*"?([^"<]*?)"?\s*<([^<>\s@]+@[^<>\s@]+)>\s*$/.exec(value);
	if (named?.[2]) return named[1] ? { email: named[2], name: named[1] } : { email: named[2] };
	const bare = value.trim();
	return /^[^<>\s@]+@[^<>\s@]+$/.test(bare) ? { email: bare } : undefined;
}

const EMAIL_PROVIDERS = ["console", "webhook"] as const;

function webhookConfigFromEnv() {
	return Effect.gen(function* () {
		const production =
			(yield* Config.String("NODE_ENV").pipe(Config.withDefault(""))) === "production";
		const url = yield* Config.URL("EMAIL_WEBHOOK_URL");
		const token = yield* Config.option(Config.Redacted("EMAIL_WEBHOOK_TOKEN"));
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return yield* new InvalidEmailConfig({ message: "EMAIL_WEBHOOK_URL must use HTTP or HTTPS" });
		}
		if (production && url.protocol !== "https:") {
			return yield* new InvalidEmailConfig({
				message: "EMAIL_WEBHOOK_URL must use HTTPS in production",
			});
		}
		return { url: url.href, token: Option.getOrUndefined(token) } satisfies WebhookEmailConfig;
	});
}

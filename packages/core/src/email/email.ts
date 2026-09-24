import { Context, Data, type Effect, Layer } from "effect";
import { type ConsoleEmailConfig, toConsole } from "./implementations/console.ts";
import { type WebhookEmailConfig, webhook } from "./implementations/webhook.ts";

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

/** Which implementation sends email, and its settings. */
export type EmailServiceConfig = ConsoleEmailConfig | WebhookEmailConfig;

/**
 * Sends email through the implementation the installation is configured with.
 * The statics are those implementations; `fromConfig` picks one.
 */
export class EmailService extends Context.Service<
	EmailService,
	{
		readonly send: (email: Email) => Effect.Effect<void, EmailDeliveryFailed>;
	}
>()("@sugabots/core/EmailService") {
	/** Prints each email instead of sending it. For development only. */
	static readonly toConsole = Layer.succeed(this, toConsole);

	/** Posts each email as JSON to `config.url`, for a relay the installation runs itself. */
	static readonly webhook = (config: WebhookEmailConfig, fetch?: typeof globalThis.fetch) =>
		Layer.succeed(this, webhook(config, fetch));

	/** The implementation `config.provider` names. */
	static readonly fromConfig = (config: EmailServiceConfig) => {
		switch (config.provider) {
			case "console":
				return EmailService.toConsole;
			case "webhook":
				return EmailService.webhook(config);
		}
	};
}

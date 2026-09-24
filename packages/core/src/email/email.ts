import { Context, Data, type Effect, Layer } from "effect";
import { type ConsoleEmailConfig, fromConsole } from "./implementations/console.ts";
import { fromWebhook, type WebhookEmailConfig } from "./implementations/webhook.ts";

/**
 * Sends email through the implementation the installation is configured with.
 * Each `from…` static is one implementation; `fromConfig` picks the one configured.
 */
export class EmailService extends Context.Service<
	EmailService,
	{
		readonly send: (email: Email) => Effect.Effect<void, EmailDeliveryFailed>;
	}
>()("@sugabots/core/EmailService") {
	/** Prints each email instead of sending it. For development only. */
	static readonly fromConsole = Layer.succeed(this, fromConsole);

	/** Posts each email as JSON to `config.url`, for a relay the installation runs itself. */
	static readonly fromWebhook = (config: WebhookEmailConfig) =>
		Layer.effect(this, fromWebhook(config));

	/** The implementation `config.provider` names. */
	static readonly fromConfig = (config: EmailServiceConfig) => {
		switch (config.provider) {
			case "console":
				return EmailService.fromConsole;
			case "webhook":
				return EmailService.fromWebhook(config);
		}
	};
}

/** Which implementation sends email, and its settings. */
export type EmailServiceConfig = ConsoleEmailConfig | WebhookEmailConfig;

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

import { Context, type Effect, Layer } from "effect";
import type { Email, EmailDeliveryFailed } from "./email.ts";
import { type ConsoleEmailConfig, toConsole } from "./implementations/console.ts";
import { type WebhookEmailConfig, webhook } from "./implementations/webhook.ts";

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

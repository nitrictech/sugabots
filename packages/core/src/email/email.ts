import { Context, Data, type Effect } from "effect";

/** A plain-text email to one address. */
export interface Email {
	to: string;
	subject: string;
	text: string;
}

/** The configured provider did not accept an email. */
export class EmailDeliveryFailed extends Data.TaggedError("EmailDeliveryFailed")<{
	provider: string;
	cause: unknown;
}> {}

/**
 * Sends email through the provider the installation is configured with. Each
 * provider in `providers/` is a layer for this service, and `emailLayer` picks
 * one from an `EmailConfig`.
 */
export class EmailService extends Context.Service<
	EmailService,
	{
		readonly send: (email: Email) => Effect.Effect<void, EmailDeliveryFailed>;
	}
>()("EmailService") {}

import { Context, Data, type Effect } from "effect";

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

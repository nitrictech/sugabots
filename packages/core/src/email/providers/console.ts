import { Effect, Layer } from "effect";
import { type EmailAddress, EmailService } from "../email.ts";

export interface ConsoleEmailConfig {
	provider: "console";
}

/** Prints each email instead of sending it. For development only. */
export const consoleEmailLayer = Layer.succeed(
	EmailService,
	EmailService.of({
		send: (email) =>
			Effect.sync(() =>
				console.log(
					`email from ${formatAddress(email.from)} to ${email.to.map(formatAddress).join(", ")}: ${email.subject}\n${email.text ?? email.html}`,
				),
			),
	}),
);

function formatAddress(address: EmailAddress) {
	return address.name ? `${address.name} <${address.email}>` : address.email;
}

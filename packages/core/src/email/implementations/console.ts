import { Effect } from "effect";
import type { EmailAddress } from "../email.ts";
// Type-only: email-service.ts imports this module, so a runtime import back would be a cycle.
import type { EmailService } from "../email-service.ts";

export interface ConsoleEmailConfig {
	provider: "console";
}

export const toConsole: EmailService["Service"] = {
	send: (email) =>
		Effect.sync(() =>
			console.log(
				`email from ${formatAddress(email.from)} to ${email.to.map(formatAddress).join(", ")}: ${email.subject}\n${email.text ?? email.html}`,
			),
		),
};

function formatAddress(address: EmailAddress) {
	return address.name ? `${address.name} <${address.email}>` : address.email;
}

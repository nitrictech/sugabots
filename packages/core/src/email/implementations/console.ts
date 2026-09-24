import { Effect } from "effect";
// Type-only: email.ts imports this module, so a runtime import back would be a cycle.
import type { EmailAddress, EmailService } from "../email.ts";

export const fromConsole: EmailService["Service"] = {
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

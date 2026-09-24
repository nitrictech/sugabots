import { Effect } from "effect";
// Type-only: email.ts imports this module, so a runtime import back would be a cycle.
import type { Email, EmailAddress } from "../email.ts";

// Typed through `Email` rather than `EmailService["Service"]`: EmailService's
// `make` returns this, so naming the service type here would be circular.
export const fromConsole = {
	send: (email: Email) =>
		Effect.sync(() =>
			console.log(
				`email from ${formatAddress(email.from)} to ${email.to.map(formatAddress).join(", ")}: ${email.subject}\n${email.text ?? email.html}`,
			),
		),
};

function formatAddress(address: EmailAddress) {
	return address.name ? `${address.name} <${address.email}>` : address.email;
}

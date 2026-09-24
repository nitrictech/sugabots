import { Effect } from "effect";
import type { Email, EmailAddress } from "../email.ts";

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

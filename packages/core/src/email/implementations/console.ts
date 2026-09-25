import { Effect } from "effect";
import type { Email } from "../email.ts";

export const fromConsole: Email.Interface = {
	send: (message) =>
		Effect.sync(() =>
			console.log(
				`email from ${formatAddress(message.from)} to ${message.to.map(formatAddress).join(", ")}: ${message.subject}\n${message.text ?? message.html}`,
			),
		),
};

function formatAddress(address: Email.Address) {
	return address.name ? `${address.name} <${address.email}>` : address.email;
}

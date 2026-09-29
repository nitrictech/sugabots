import { Duration, Effect, type Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Email } from "../email.ts";

const SEND_URL = "https://api.resend.com/emails";

const TIMEOUT = Duration.seconds(15);

/** Sends through Resend's API, authenticated with an API key. */
export const fromResend = (apiKey: Redacted.Redacted) =>
	Effect.map(HttpClient.HttpClient, (client): Email.Interface => {
		const http = HttpClient.filterStatusOk(client);
		return {
			send: (message) =>
				HttpClientRequest.post(SEND_URL).pipe(
					HttpClientRequest.bearerToken(apiKey),
					HttpClientRequest.bodyJsonUnsafe(resendBody(message)),
					http.execute,
					Effect.timeout(TIMEOUT),
					Effect.asVoid,
					Effect.mapError((cause) => new Email.DeliveryFailed({ provider: "resend", cause })),
				),
		};
	});

function resendBody(message: Email.Message) {
	return {
		from: formatAddress(message.from),
		to: message.to.map(formatAddress),
		cc: message.cc?.map(formatAddress),
		bcc: message.bcc?.map(formatAddress),
		reply_to: message.replyTo && formatAddress(message.replyTo),
		subject: message.subject,
		text: message.text,
		html: message.html,
	};
}

/** `"Name" <address>`, quoted so a name with a comma or angle bracket stays one name. */
function formatAddress(address: Email.Address): string {
	if (!address.name) return address.email;
	return `"${address.name.replaceAll(/["\\]/g, "\\$&")}" <${address.email}>`;
}

import { Effect, Layer } from "effect";
import {
	authenticated,
	type BotForAsker,
	type PageAddress,
	type WebhookCall,
} from "../principal.ts";
import { SessionAuthentication } from "./session.ts";

/** The session authenticator for HTTP cases run without a database. */
export const sessionsFromCookies = Layer.succeed(SessionAuthentication.Service, {
	authenticate: (headers) =>
		Effect.gen(function* () {
			const cookies = yield* SessionAuthentication.Cookies;
			const found = yield* cookies.read(headers);
			if (!found) return yield* new SessionAuthentication.SessionInvalid();
			return authenticated.memberSession(found);
		}),
});

/** A bot acting for its asker in the turn `turn`, in chat bounds of `project`. */
export const botForAskerForTests = (fields: {
	readonly turn: string;
	readonly chat: string;
	readonly project: string;
}): BotForAsker =>
	authenticated.botForAsker({
		workspace: "0199a3a0-0000-7000-8000-0000000000a1",
		bot: "0199a3a0-0000-7000-8000-0000000000a2",
		asker: "0199a3a0-0000-7000-8000-0000000000a3",
		askedByAutomation: false,
		chat: fields.chat,
		turn: fields.turn,
		executionNumber: 1,
		admission: null,
		bounds: { kind: "chat", project: fields.project },
	});

export const pageAddressForTests = (fields: Omit<PageAddress, "_tag">): PageAddress =>
	authenticated.pageAddress(fields);

export const webhookCallForTests = (fields: Omit<WebhookCall, "_tag">): WebhookCall =>
	authenticated.webhookCall(fields);

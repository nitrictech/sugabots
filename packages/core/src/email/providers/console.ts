import { Effect, Layer } from "effect";
import { EmailService } from "../email.ts";

export interface ConsoleEmailConfig {
	provider: "console";
}

/** Prints each email instead of sending it. For development only. */
export const consoleEmailLayer = Layer.succeed(
	EmailService,
	EmailService.of({
		send: ({ to, subject, text }) =>
			Effect.sync(() => console.log(`email to ${to}: ${subject}\n${text}`)),
	}),
);

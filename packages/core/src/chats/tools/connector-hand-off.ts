import { type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";

/**
 * How a connector's tool hands its request to the network: the call's context
 * carries a hand-off that proves again, as the request goes, that the call may
 * still go, so a tool that reads a file or prepares work first doesn't send
 * after the connector is turned off or its asker lost the right to use it. A
 * request already handed to the network when that happens may finish.
 */

/**
 * Starts `send`, which hands the request to the network, once the call has
 * been proved again; the proof holds until `send` has started. Rejects with
 * {@link HandOffRefused} when the call may no longer go.
 */
export type HandOff = <A>(send: () => Promise<A>) => Promise<A>;

/** A connector call's hand-off refused to send, as the call may no longer go. */
export class HandOffRefused
	extends Schema.TaggedError<HandOffRefused>()("HandOffRefused", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The connector call may no longer be sent";
	}
	get userMessage() {
		return userText`This connector can't be used here any more, so nothing was sent.`;
	}
}

/** The key the hand-off is kept under in the call's context. */
const HAND_OFF = "connectorHandOff";

/** The call's context `context`, carrying `handOff`. */
export function withHandOff(context: unknown, handOff: HandOff): Record<string, unknown> {
	const carried = typeof context === "object" && context !== null ? { ...context } : {};
	return { ...carried, [HAND_OFF]: handOff };
}

/**
 * The hand-off the call's context carries. A tool run outside a connector
 * call, as a case runs one, carries none and sends straight away.
 */
export function readHandOff(context: unknown): HandOff {
	const carried =
		typeof context === "object" && context !== null ? Reflect.get(context, HAND_OFF) : undefined;
	return typeof carried === "function" ? (carried as HandOff) : (send) => send();
}

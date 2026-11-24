/**
 * An operation's body: the one place its check-then-act order is written.
 * It names the values it acts on, proves what it needs, and calls services
 * with those proofs:
 *
 * ```ts
 * export const setResolved = defineOperation(contracts.setResolved, (principal, input) =>
 * 	named(principal, input.chatId, (principal, chat) => …),
 * );
 * ```
 *
 * An operation whose bot-loop decision can need approval names its call
 * with the principal and its input ids in one `named`, so `Approved<P, X>`
 * shares the principal its other proofs are about.
 *
 * Its contract, in `@sugabots/contracts/operations`, says what it takes,
 * returns and fails with; the body's type must keep to it.
 */

import type { OperationContract } from "@sugabots/contracts/operations";
import type { Effect } from "effect";
import type { Principal } from "../principal.ts";

/**
 * One call of an operation, the `X` of `Approved<P, X>`, which the registry
 * hands its body with the principal and input. A bot's tool call is the
 * `tool_call` row the bot loop recorded before calling, which its approval is
 * stored against. Any other call (an HTTP request, one of the bot loop's own
 * calls, a webhook call or work the scheduler starts) is identified by the
 * entrypoint that made it, and is never approved by a stored decision.
 */
export type Call =
	| { readonly kind: "toolCall"; readonly toolCall: string }
	| { readonly kind: "request"; readonly request: string };

export interface Operation<Contract extends OperationContract.Contract, Services> {
	readonly contract: Contract;
	readonly run: (
		principal: Principal,
		input: OperationContract.Input<Contract>,
		call: Call,
	) => Effect.Effect<
		OperationContract.Output<Contract>,
		OperationContract.Failure<Contract>,
		Services
	>;
}

export const defineOperation = <Contract extends OperationContract.Contract, Services>(
	contract: Contract,
	run: Operation<Contract, Services>["run"],
): Operation<Contract, Services> => ({ contract, run });

/** The services an operation's body needs, which the registry supplies when it is built. */
export type ServicesOf<Of> = Of extends {
	readonly run: (...args: never) => Effect.Effect<unknown, unknown, infer Services>;
}
	? Services
	: never;

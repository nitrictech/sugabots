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
 * Its contract, in `@sugabots/contracts/operations`, says what it takes,
 * returns and fails with; the body's type must keep to it.
 */

import type { OperationContract } from "@sugabots/contracts/operations";
import type { Effect } from "effect";
import type { Principal } from "../principal.ts";

export interface Operation<Contract extends OperationContract.Contract, Services> {
	readonly contract: Contract;
	readonly run: (
		principal: Principal,
		input: OperationContract.Input<Contract>,
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

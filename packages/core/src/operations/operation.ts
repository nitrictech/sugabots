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
 * with the principal and its input ids in one `named`, so `Approved<P, X, Targets, Operation>`
 * shares the principal its other proofs are about.
 *
 * Its contract, in `@sugabots/contracts/operations`, says what it takes,
 * returns and fails with; the body's type must keep to it.
 */

import { ApprovalNeeded } from "@sugabots/contracts/errors/proofs";
import type { OperationContract } from "@sugabots/contracts/operations";
import { Effect, Schema, type Scope, type Stream } from "effect";
import type { Principal } from "../principal.ts";

/** Runs the operation's proofs up to Approved, before any write or provider call. */
export interface ApprovalCheck {
	readonly kind: "approvalCheck";
}

/**
 * What a tool call's names and ids stood for as its approval was asked, by a
 * name its operation gives each: an id, or null where it stood for nothing yet,
 * such as a computer not made yet.
 */
export type ResolvedTargets = { readonly [name: string]: string | null };

interface ApprovalCheckDetails {
	readonly computerProjectId?: string;
	/** What the call's names and ids stand for now, which its approval covers. */
	readonly resolvedTargets?: ResolvedTargets;
	readonly connectorAccess?: "allow" | "ask";
	readonly writeOrDelete: boolean;
}

export class ApprovalCheckReached extends ApprovalNeeded {
	declare readonly details: ApprovalCheckDetails;

	static for(details: ApprovalCheckDetails): ApprovalCheckReached {
		return Object.assign(new ApprovalCheckReached(), { details });
	}
}

/**
 * One call of an operation, the `X` of `Approved<P, X, Targets, Operation>`, which the registry
 * hands its body with the principal and input. A bot's tool call is the
 * `tool_call` row the bot loop recorded before calling, which its approval is
 * stored against. An approval check stops at the
 * approval proof after the operation has checked its other requirements.
 */
export type Call =
	| ApprovalCheck
	| { readonly kind: "toolCall"; readonly toolCall: string }
	| { readonly kind: "request" };

export interface Operation<Contract extends OperationContract.Contract, Services> {
	readonly kind: "request";
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

export const defineOperation = <
	Contract extends OperationContract.Contract & { readonly kind: "request" },
	Services,
>(
	contract: Contract,
	run: Operation<Contract, Services>["run"],
): Operation<Contract, Services> => ({
	kind: "request",
	contract,
	run: decodingInputFirst(contract, run),
});

/**
 * A long-running operation's body (see `OperationContract.Kind`): it proves
 * access as it starts, failing with a refusal then, and returns what it
 * yields while it runs, a stream that ends once it must. What it holds open,
 * such as its subscriptions and the proving again, belongs to the scope it is
 * given, which its entrypoint closes when its caller leaves.
 */
export interface LongRunningOperation<Contract extends OperationContract.Contract, Services> {
	readonly kind: "longRunning";
	readonly contract: Contract;
	readonly run: (
		principal: Principal,
		input: OperationContract.Input<Contract>,
		call: Call,
	) => Effect.Effect<
		Running<OperationContract.Output<Contract>>,
		OperationContract.Failure<Contract>,
		Services | Scope.Scope
	>;
}

export const defineLongRunningOperation = <
	Contract extends OperationContract.Contract & { readonly kind: "longRunning" },
	Services,
>(
	contract: Contract,
	run: LongRunningOperation<Contract, Services>["run"],
): LongRunningOperation<Contract, Services> => ({
	kind: "longRunning",
	contract,
	run: decodingInputFirst(contract, run),
});

/**
 * `run`, decoding its input through the contract's input schema first, so
 * checks across fields, such as a message needing text or a file, hold
 * whoever calls it. An input the schema refuses is a defect: an entrypoint
 * decodes what it is sent first, and answers its mistakes itself.
 */
const decodingInputFirst = <Contract extends OperationContract.Contract, A, E, R>(
	contract: Contract,
	run: (
		principal: Principal,
		input: OperationContract.Input<Contract>,
		call: Call,
	) => Effect.Effect<A, E, R>,
) => {
	const decodeInput = Schema.decodeUnknownEffect(Schema.toType(contract.input));
	return (principal: Principal, input: OperationContract.Input<Contract>, call: Call) =>
		decodeInput(input).pipe(
			Effect.catch((error) =>
				Effect.die(
					new Error(`${contract.name} was called with an input its contract refuses`, {
						cause: error,
					}),
				),
			),
			Effect.flatMap((decoded) =>
				run(principal, decoded as OperationContract.Input<Contract>, call),
			),
		);
};

/** The services an operation's body needs, which the registry supplies when it is built. */
export type ServicesOf<Of> = Of extends {
	readonly run: (...args: never) => Effect.Effect<unknown, unknown, infer Services>;
}
	? Exclude<Services, Scope.Scope>
	: never;

export interface Running<Output> {
	readonly stream: Stream.Stream<Output>;
	readonly ended: Effect.Effect<void>;
}

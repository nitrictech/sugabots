/**
 * The bot loop's way into the turn it runs, beside the operations: loading
 * the turn for a step, the step's model request, its tool calls and their
 * results, asking for approvals, ending the turn, and offering the step's
 * tools. Only the loop calls these, in its own process, for the turn's own
 * principal, so none is an operation with a contract.
 *
 * Each method but `endLost` first proves that the principal runs its turn
 * (`RunsTurn`): it was admitted to run the turn, and the turn hasn't ended. Each write then checks again, in its own SQL, that the
 * principal's execution of the turn is still the current one, so an execution
 * a newer one took over records nothing more.
 */
export * as RunningTurn from "./running-turn.ts";

import type { BotCannotReach, ResourceHidden, TurnEnded } from "@sugabots/contracts/errors/proofs";
import type { TurnExecutionSuperseded } from "@sugabots/contracts/errors/turns";
import { Context, Effect, Layer, Scope } from "effect";
import { Turns, WorkAdmission } from "../chats/turns/turns.ts";
import type { BotPrincipal } from "../principal.ts";
import { proveEndsTurn } from "../proofs/ends-turn.ts";
import { named } from "../proofs/proof.ts";
import { proveRunsTurn, type RunsTurn } from "../proofs/runs-turn.ts";
import { processLayer, Tier } from "../tiers.ts";
import { Operations } from "./registry.ts";

/** How a method refuses once its principal no longer runs the turn. */
export type Refusal = TurnEnded | TurnExecutionSuperseded | ResourceHidden | BotCannotReach;

type Records = Turns.Records.Interface;

/** A method of `Turns.Records`, for the turn `principal` runs rather than a proof that it does. */
type ForPrincipal<Method> = Method extends (
	runsTurn: RunsTurn<unknown, unknown>,
	...args: infer Args
) => Effect.Effect<infer A, infer _E>
	? (principal: BotPrincipal, ...args: Args) => Effect.Effect<A, Refusal>
	: never;

export interface Interface {
	readonly load: ForPrincipal<Records["load"]>;
	readonly makeModelRequest: ForPrincipal<Records["makeModelRequest"]>;
	readonly recordToolCall: ForPrincipal<Records["recordToolCall"]>;
	readonly planToolCalls: ForPrincipal<Records["planToolCalls"]>;
	readonly finishToolCall: ForPrincipal<Records["finishToolCall"]>;
	readonly startApprovedToolCall: ForPrincipal<Records["startApprovedToolCall"]>;
	readonly recordToolResults: ForPrincipal<Records["recordToolResults"]>;
	readonly end: ForPrincipal<Records["end"]>;
	/**
	 * Parks the turn until its approvers decide the step's calls, once the
	 * workspace admits the wait. `NotWaiting` when it doesn't, or the turn was
	 * asked to stop.
	 */
	readonly askForApprovals: (
		principal: BotPrincipal,
		step: number,
		approvals: Parameters<Records["askForApprovals"]>[2],
	) => Effect.Effect<Effect.Success<ReturnType<Records["askForApprovals"]>>, Refusal>;
	/**
	 * Ends the turn as failed after it lost its chat or its step died, or as it
	 * was asked to end, whatever its principal still reaches; refused once it
	 * ended or a newer execution took it over.
	 */
	readonly endLost: (
		principal: BotPrincipal,
		ending: Parameters<Records["endLost"]>[1],
	) => Effect.Effect<void, TurnEnded | TurnExecutionSuperseded | ResourceHidden>;
	/**
	 * The tools the step offers, live for as long as the scope it is given:
	 * each calls its operation, or its connector, as the turn's principal,
	 * recording the call through `recorder`.
	 */
	readonly offerStepTools: (
		principal: BotPrincipal,
		turn: Omit<Turns.Tools.StepTurn, "turnId" | "executionNumber">,
		recorder: Turns.Tools.ToolCallRecorder,
	) => Effect.Effect<
		Effect.Success<ReturnType<Turns.Tools.Interface["forStep"]>>,
		Refusal,
		Scope.Scope
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/RunningTurn") {
	declare readonly [Tier]: "process";
}

/** Over the turns' records and tools, and the operations a step's tools call. */
export const make = Effect.gen(function* () {
	const records = yield* Turns.Records.Service;
	const tools = yield* Turns.Tools.Service;
	const operations = yield* Operations.Service;
	// What proving and parking need: the database, the work admission and the
	// records. Without the scope the service is built in, so what a step opens
	// is released when the caller's scope closes, at the end of the step.
	const context = Context.omit(Scope.Scope)(
		yield* Effect.context<Effect.Services<ReturnType<typeof askForApprovals>>>(),
	);
	const proving = <A, E, R>(
		principal: BotPrincipal,
		use: <P, T>(runsTurn: RunsTurn<P, T>) => Effect.Effect<A, E, R>,
	) => asRunningTurn(principal, use).pipe(Effect.provideContext(context));

	return Service.of({
		load: (principal, step) => proving(principal, (runs) => records.load(runs, step)),
		makeModelRequest: (principal, request) =>
			proving(principal, (runs) => records.makeModelRequest(runs, request)),
		recordToolCall: (principal, call) =>
			proving(principal, (runs) => records.recordToolCall(runs, call)),
		planToolCalls: (principal, plans) =>
			proving(principal, (runs) => records.planToolCalls(runs, plans)),
		finishToolCall: (principal, callId, outcome) =>
			proving(principal, (runs) => records.finishToolCall(runs, callId, outcome)),
		startApprovedToolCall: (principal, call) =>
			proving(principal, (runs) => records.startApprovedToolCall(runs, call)),
		recordToolResults: (principal, results) =>
			proving(principal, (runs) => records.recordToolResults(runs, results)),
		end: (principal, ending) => proving(principal, (runs) => records.end(runs, ending)),
		askForApprovals: (principal, step, approvals) =>
			askForApprovals(principal, step, approvals).pipe(Effect.provideContext(context)),
		endLost: (principal, ending) =>
			named(principal, principal.turn, (principal, turn) =>
				Effect.flatMap(proveEndsTurn(principal, turn), (endsTurn) =>
					records.endLost(endsTurn, ending),
				),
			).pipe(Effect.provideContext(context)),
		offerStepTools: (principal, turn, recorder) =>
			proving(principal, (running) => tools.forStep(running, operations, turn, recorder)),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(Turns.Records.layer));

/**
 * Proves that `principal` runs its own turn, and runs `use` with the proof:
 * the one check every method but `endLost` makes.
 */
export const asRunningTurn = <A, E, R>(
	principal: BotPrincipal,
	use: <P, T>(runsTurn: RunsTurn<P, T>) => Effect.Effect<A, E, R>,
) =>
	named(principal, principal.turn, (principal, turn) =>
		Effect.gen(function* () {
			const runsTurn = yield* proveRunsTurn(principal, turn);
			return yield* use(runsTurn);
		}),
	);

/** `askForApprovals`, over the services it is built from. */
export const askForApprovals = (
	principal: BotPrincipal,
	step: number,
	approvals: Parameters<Records["askForApprovals"]>[2],
) =>
	Effect.flatMap(Turns.Records.Service, (records) =>
		WorkAdmission.underApprovalAdmission(principal.chat, (admitted) =>
			asRunningTurn(principal, (runs) =>
				admitted
					? records.askForApprovals(runs, step, approvals, admitted)
					: Effect.succeed({ _tag: "NotWaiting" } as const),
			),
		),
	);

export * as Operations from "./registry.ts";

import { isDeepStrictEqual } from "node:util";
import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import {
	botLoopTools,
	type FailureOf,
	type InputOf,
	type LongRunningOperationName,
	type OperationContracts,
	type OperationName,
	type OutputOf,
	operationContracts,
	type RequestOperationName,
} from "@sugabots/contracts/operations";
import type { DomainError } from "@sugabots/errors";
import { Context, Effect, Layer, Schema, Scope } from "effect";
import { principalForApprovalCheck } from "../authentication/approval.ts";
import { refreshTurnAdmission } from "../authentication/turn-admission.ts";
import { isBrowserTool } from "../chats/tools/browser/browser.ts";
import type { Turns } from "../chats/turns/turns.ts";
import type { Principal } from "../principal.ts";
import { proveCanUseChatComputer } from "../proofs/can-use-computer.ts";
import { checkConnectorApprovalPermission } from "../proofs/can-use-connector.ts";
import { named } from "../proofs/proof.ts";
import { processLayer, Tier } from "../tiers.ts";
import { makeDecide } from "./approvals/decide.ts";
import { automationsOperations } from "./automations/index.ts";
import { botsOperations } from "./bots/index.ts";
import { chatReadsOperations } from "./chat-reads/index.ts";
import { chatsOperations } from "./chats/index.ts";
import { computersOperations } from "./computers/index.ts";
import { connectorsOperations } from "./connectors/index.ts";
import { eventsOperations } from "./events/index.ts";
import { filesOperations } from "./files/index.ts";
import { notificationsOperations } from "./notifications/index.ts";
import {
	type Call,
	checkApproval,
	type LongRunningOperation,
	type Operation,
	type Running,
	type ServicesOf,
} from "./operation.ts";
import { projectsOperations } from "./projects/index.ts";
import { providersOperations } from "./providers/index.ts";
import { scheduledWorkOperations } from "./scheduled-work.ts";
import { webOperations } from "./web/index.ts";
import { workspaceOperations } from "./workspace/index.ts";

/**
 * Every operation that runs once per call, by name, for a principal an
 * entrypoint authenticated. The one way into the core, with
 * {@link LongRunning}, but for the bot loop's records of the turn it runs
 * (`RunningTurn`): every entrypoint calls these, with the call it is making,
 * and each proves access for itself.
 *
 * Each operation decodes its input through its contract's input schema
 * before its body sees it (see `defineOperation`).
 */
export type Interface = {
	readonly [Name in RequestOperationName]: (
		principal: Principal,
		input: InputOf<Name>,
		call: Call,
	) => Effect.Effect<OutputOf<Name>, FailureOf<Name>>;
};

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Operations") {
	declare readonly [Tier]: "process";
}

/**
 * The registry's long-running operations, by name: following a stream, and
 * the desktop viewer. Each returns, once it has proved access, what it yields
 * while it runs, for as long as the scope it is given stays open and it may
 * (see `LongRunningOperation`).
 */
export type LongRunningInterface = {
	readonly [Name in LongRunningOperationName]: (
		principal: Principal,
		input: InputOf<Name>,
		call: Call,
	) => Effect.Effect<Running<OutputOf<Name>>, FailureOf<Name>, Scope.Scope>;
};

export class LongRunning extends Context.Service<LongRunning, LongRunningInterface>()(
	"@sugabots/core/Operations/LongRunning",
) {
	declare readonly [Tier]: "process";
}

const operationsExceptDecide = {
	...workspaceOperations,
	...projectsOperations,
	...botsOperations,
	...chatsOperations,
	...chatReadsOperations,
	...filesOperations,
	...automationsOperations,
	...computersOperations,
	...connectorsOperations,
	...providersOperations,
	...webOperations,
	...eventsOperations,
	...notificationsOperations,
	...scheduledWorkOperations,
};

const offeredTools = botLoopTools(operationContracts);
type ApprovalOperationName = (typeof offeredTools)[number]["operation"];
type ApprovalServices = ServicesOf<(typeof operationsExceptDecide)[ApprovalOperationName]>;

const checkApprovalPermission = (
	member: string,
	call: Turns.ApprovalCall,
	executionNumber: number,
) =>
	Effect.gen(function* () {
		const forbidden = new ActionForbidden({ proof: "CanDecide" });
		if (call.connectorId) {
			yield* checkConnectorApprovalPermission(member, {
				connectorId: call.connectorId,
				turnId: call.turnId,
				writeOrDelete: call.writeOrDelete,
			});
			if (call.approvalResolvedTargets && "computer" in call.approvalResolvedTargets) {
				const principal = yield* principalForApprovalCheck(call.turnId, member, executionNumber);
				yield* named(principal, principal.chat, (principal, chat) =>
					proveCanUseChatComputer(principal, chat).pipe(
						Effect.asVoid,
						Effect.mapError(() => forbidden),
					),
				);
			}
			return;
		}

		const { tool } = call;
		const recordedInput = call.executionInput ?? call.input;
		const browserTool = isBrowserTool(tool, true);
		const name = browserTool
			? "computers.useBrowser"
			: offeredTools.find((offered) => offered.tool === tool)?.operation;
		if (!name || name === "connectors.callTool") return yield* forbidden;
		const decoded = Schema.decodeUnknownResult(operationContracts[name].input)(
			browserTool ? { tool, arguments: recordedInput } : recordedInput,
		);
		if (decoded._tag === "Failure") return yield* forbidden;

		const principal = yield* principalForApprovalCheck(call.turnId, member, executionNumber);
		const operation: RegisteredOperation<ApprovalServices> = operationsExceptDecide[name];
		const checked = yield* checkApproval(
			(check) => operation.run(principal, decoded.success as never, check),
			{ kind: "approvalCheck", forDecision: true },
		);
		if (!checked) return yield* forbidden;
		if (
			checked.resolvedTargets &&
			!isDeepStrictEqual(checked.resolvedTargets, call.approvalResolvedTargets)
		) {
			if (name === "chats.startBriefedChat") return "briefDestinationChanged" as const;
			return yield* forbidden;
		}
		return undefined;
	});

/** Every operation's body, by name: exactly one for each registered contract. */
const operations = {
	...operationsExceptDecide,
	"approvals.decide": makeDecide(checkApprovalPermission),
} satisfies {
	readonly [Name in OperationName]: Name extends LongRunningOperationName
		? LongRunningOperation<OperationContracts[Name], unknown>
		: Operation<OperationContracts[Name], unknown>;
};

type Operations = typeof operations;

/** The services the operations' bodies need, supplied once when the registry is built. */
type Services = ServicesOf<Operations[keyof Operations]>;

/** Any one of the operations, with what its input is forgotten: the registry only passes it on. */
interface RegisteredOperation<R = Services | Scope.Scope> {
	readonly kind: "request" | "longRunning";
	readonly run: (
		principal: Principal,
		input: never,
		call: Call,
	) => Effect.Effect<unknown, DomainError, R>;
}

/**
 * The registry, built over the services its operations need: the operations
 * that run once per call as {@link Service}, the long-running ones as
 * {@link LongRunning}.
 */
export const make = Effect.gen(function* () {
	// Without the scope the registry is built in: a long-running operation's
	// subscriptions and fibres belong to the scope its caller gives it, which
	// closes when its caller leaves, not to the process's.
	const context = Context.omit(Scope.Scope)(yield* Effect.context<Services>());
	const entriesOf = (kind: RegisteredOperation["kind"]) =>
		Object.entries<RegisteredOperation>(operations)
			.filter(([, operation]) => operation.kind === kind)
			.map(([name, operation]) => [
				name,
				(principal: Principal, input: never, call: Call) =>
					refreshTurnAdmission(principal).pipe(
						Effect.flatMap((acting) => operation.run(acting, input, call)),
						Effect.provideContext(context),
						Effect.withSpan(name),
					),
			]);
	return Context.make(Service, Object.fromEntries(entriesOf("request")) as Interface).pipe(
		Context.add(LongRunning, Object.fromEntries(entriesOf("longRunning")) as LongRunningInterface),
	);
});

export const layerNoDeps = processLayer(Layer.effectContext(make));

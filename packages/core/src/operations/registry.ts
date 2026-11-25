export * as Operations from "./registry.ts";

import type {
	FailureOf,
	InputOf,
	LongRunningOperationName,
	OperationContracts,
	OperationName,
	OutputOf,
	RequestOperationName,
} from "@sugabots/contracts/operations";
import type { DomainError } from "@sugabots/errors";
import { Context, Effect, Layer, Scope } from "effect";
import type { Principal } from "../principal.ts";
import { processLayer, Tier } from "../tiers.ts";
import { approvalsOperations } from "./approvals/index.ts";
import { automationsOperations } from "./automations/index.ts";
import { botsOperations } from "./bots/index.ts";
import { chatReadsOperations } from "./chat-reads/index.ts";
import { chatsOperations } from "./chats/index.ts";
import { computersOperations } from "./computers/index.ts";
import { connectorsOperations } from "./connectors/index.ts";
import { eventsOperations } from "./events/index.ts";
import { filesOperations } from "./files/index.ts";
import { notificationsOperations } from "./notifications/index.ts";
import type { Call, LongRunningOperation, Operation, Running, ServicesOf } from "./operation.ts";
import { projectsOperations } from "./projects/index.ts";
import { providersOperations } from "./providers/index.ts";
import { scheduledWorkOperations } from "./scheduled-work.ts";
import { turnsOperations } from "./turns/index.ts";
import { webOperations } from "./web/index.ts";
import { workspaceOperations } from "./workspace/index.ts";

/**
 * Every operation that runs once per call, by name, for a principal an
 * entrypoint authenticated. The one way into the core, with
 * {@link LongRunning}: every entrypoint calls these, with the call it is
 * making, and each proves access for itself.
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

/** Every operation's body, by name: exactly one for each registered contract. */
const operations = {
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
	...approvalsOperations,
	...eventsOperations,
	...turnsOperations,
	...notificationsOperations,
	...scheduledWorkOperations,
} satisfies {
	readonly [Name in OperationName]: Name extends LongRunningOperationName
		? LongRunningOperation<OperationContracts[Name], unknown>
		: Operation<OperationContracts[Name], unknown>;
};

type Operations = typeof operations;

/** The services the operations' bodies need, supplied once when the registry is built. */
type Services = ServicesOf<Operations[keyof Operations]>;

/** Any one of the operations, with what its input is forgotten: the registry only passes it on. */
interface RegisteredOperation {
	readonly kind: "request" | "longRunning";
	readonly run: (
		principal: Principal,
		input: never,
		call: Call,
	) => Effect.Effect<unknown, DomainError, Services | Scope.Scope>;
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
					operation
						.run(principal, input, call)
						.pipe(Effect.provideContext(context), Effect.withSpan(name)),
			]);
	return Context.make(Service, Object.fromEntries(entriesOf("request")) as Interface).pipe(
		Context.add(LongRunning, Object.fromEntries(entriesOf("longRunning")) as LongRunningInterface),
	);
});

export const layerNoDeps = processLayer(Layer.effectContext(make));

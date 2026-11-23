export * as Operations from "./registry.ts";

import type {
	FailureOf,
	InputOf,
	OperationContracts,
	OperationName,
	OutputOf,
} from "@sugabots/contracts/operations";
import type { DomainError } from "@sugabots/errors";
import { Context, Effect, Layer } from "effect";
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
import type { Operation, ServicesOf } from "./operation.ts";
import { projectsOperations } from "./projects/index.ts";
import { providersOperations } from "./providers/index.ts";
import { turnsOperations } from "./turns/index.ts";
import { workspaceOperations } from "./workspace/index.ts";

/**
 * Every operation, by name, for a principal an entrypoint authenticated. The
 * one way into the core: every entrypoint calls these, and each proves access
 * for itself.
 */
export type Interface = {
	readonly [Name in OperationName]: (
		principal: Principal,
		input: InputOf<Name>,
	) => Effect.Effect<OutputOf<Name>, FailureOf<Name>>;
};

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Operations") {
	declare readonly [Tier]: "process";
}

/** Every operation's body, by name: exactly one for each registered contract. */
const operations = {
	...workspaceOperations,
	...projectsOperations,
	...botsOperations,
	...chatsOperations,
	...chatReadsOperations,
	...automationsOperations,
	...computersOperations,
	...connectorsOperations,
	...providersOperations,
	...approvalsOperations,
	...eventsOperations,
	...turnsOperations,
} satisfies {
	readonly [Name in OperationName]: Operation<OperationContracts[Name], unknown>;
};

type Operations = typeof operations;

/** The services the operations' bodies need, supplied once when the registry is built. */
type Services = ServicesOf<Operations[keyof Operations]>;

/** Any one of the operations, with what its input is forgotten: the registry only passes it on. */
interface RegisteredOperation {
	readonly run: (
		principal: Principal,
		input: never,
	) => Effect.Effect<unknown, DomainError, Services>;
}

export const make = Effect.gen(function* () {
	const context = yield* Effect.context<Services>();
	const entries = Object.entries<RegisteredOperation>(operations).map(([name, operation]) => [
		name,
		(principal: Principal, input: never) =>
			operation.run(principal, input).pipe(Effect.provideContext(context)),
	]);
	return Object.fromEntries(entries) as Interface;
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export * as ConnectorCalls from "./connector-calls.ts";

import { safeValidateTypes } from "@ai-sdk/provider-utils";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { asSchema } from "ai";
import { Context, Duration, Effect, Layer, Option } from "effect";
import { ConnectorCatalog, type OfferedTool } from "../../chats/tools/connector-catalog.ts";
import { withRecordedCall } from "../../chats/tools/recorded-call.ts";
import { buildCatalog } from "../../chats/tools/tool-search/catalog.ts";
import { searchOfferedTools } from "../../chats/tools/tool-search/tool.ts";
import type { Database } from "../../database/database.ts";
import type { BotPrincipal } from "../../principal.ts";
import type { Approved } from "../../proofs/approved.ts";
import type { CanUseConnector } from "../../proofs/can-use-connector.ts";
import type { RunsTurn } from "../../proofs/runs-turn.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { type ConnectorSessions, connectorSessions } from "./connector-sessions.ts";

export interface Interface {
	readonly offer: (
		principal: BotPrincipal,
		projects: ConnectorCatalog.TurnProjects,
		side: Omit<ConnectorCatalog.TurnSide, "principal" | "turnId" | "chatId" | "botId">,
	) => Effect.Effect<Catalog, never, Database>;
	readonly release: (execution: {
		readonly turn: string;
		readonly executionNumber?: number;
	}) => Effect.Effect<void>;
	readonly described: (
		principal: BotPrincipal,
		connectorId: string,
		tool: string,
	) => Pick<OfferedTool, "connectorRevision" | "described"> | undefined;
	readonly validateArguments: (
		principal: BotPrincipal,
		connectorId: string,
		name: string,
		args: Record<string, unknown>,
	) => Effect.Effect<
		{ readonly arguments: Record<string, unknown> } | { readonly invalid: string }
	>;
	readonly searchTools: <P, T, X>(
		turn: RunsTurn<P, T>,
		approved: Approved<NoInfer<P>, X, [T], "connectors.searchTools">,
	) => Effect.Effect<unknown, ResourceHidden>;
	readonly callTool: <P, T, K, X>(
		turn: RunsTurn<P, T>,
		use: CanUseConnector<NoInfer<P>, K>,
		approved: Approved<NoInfer<P>, X, [T, K], "connectors.callTool">,
	) => Effect.Effect<unknown, ResourceHidden>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConnectorCalls",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.map(ConnectorCatalog.Service, from);

export const layerNoDeps = processLayer(Layer.effect(Service, make));
export const layer = layerNoDeps.pipe(Layer.provide(ConnectorCatalog.layer));

type Catalog = Omit<ConnectorCatalog.ConnectorToolSet, "tools" | "close"> & {
	readonly tools: Readonly<Record<string, Omit<OfferedTool, "tool">>>;
};

interface TurnConnectors {
	readonly executionNumber: number;
	readonly sessions: ConnectorSessions;
	tools: Record<string, OfferedTool>;
	close: () => Promise<void>;
}

export function from(discovery: ConnectorCatalog.Interface): Interface {
	const turns = new Map<string, TurnConnectors>();
	const find = (principal: BotPrincipal, connectorId: string, name: string) => {
		const turn = turns.get(principal.turn);
		if (turn?.executionNumber !== principal.executionNumber) return undefined;
		return Object.values(turn.tools).find(
			(tool) => tool.connectorId === connectorId && tool.remoteToolName === name,
		);
	};

	return Service.of({
		offer: (principal, projects, side) =>
			Effect.gen(function* () {
				let turn = turns.get(principal.turn);
				if (turn && turn.executionNumber > principal.executionNumber) return emptyCatalog();
				if (turn?.executionNumber !== principal.executionNumber) {
					const previous = turn;
					turn = {
						executionNumber: principal.executionNumber,
						sessions: connectorSessions(),
						tools: {},
						close: async () => {},
					};
					turns.set(principal.turn, turn);
					if (previous) yield* closeTurnSessions(principal.turn, previous);
				}
				if (turns.get(principal.turn) !== turn) return emptyCatalog();
				const catalog = yield* discovery.forTurn(
					principal.workspace,
					projects,
					{
						...side,
						principal,
						turnId: principal.turn,
						chatId: principal.chat,
						botId: principal.bot,
					},
					turn.sessions,
				);
				if (turns.get(principal.turn) !== turn) {
					yield* closeTurnSessions(principal.turn, { ...turn, close: catalog.close });
					return emptyCatalog();
				}
				turn.tools = catalog.tools;
				turn.close = catalog.close;
				return describeCatalog(catalog);
			}),
		release: ({ turn: turnId, executionNumber }) =>
			Effect.suspend(() => {
				const turn = turns.get(turnId);
				if (!turn || (executionNumber !== undefined && turn.executionNumber > executionNumber))
					return Effect.void;
				turns.delete(turnId);
				return closeTurnSessions(turnId, turn);
			}),
		described: (principal, connectorId, name) => {
			const tool = find(principal, connectorId, name);
			return tool && { connectorRevision: tool.connectorRevision, described: tool.described };
		},
		validateArguments: (principal, connectorId, name, args) =>
			Effect.promise(async () => {
				const offered = find(principal, connectorId, name);
				if (!offered) return { invalid: "This connector tool is unavailable." };
				const missing = (offered.inputSchema.required ?? []).filter(
					(key: string) => !Object.hasOwn(args, key),
				);
				if (missing.length > 0)
					return { invalid: `Missing required arguments: ${missing.join(", ")}.` };
				const checked = await safeValidateTypes({
					value: args,
					schema: asSchema(offered.tool.inputSchema),
				});
				return checked.success
					? { arguments: checked.value as Record<string, unknown> }
					: { invalid: checked.error.message };
			}),
		searchTools: (running, approved) =>
			Effect.suspend(() => {
				const turn = turns.get(running.turn.value);
				if (!turn || turn.executionNumber !== running.execution) {
					return Effect.fail(new ResourceHidden({ resource: "connector" }));
				}
				return Effect.succeed(
					searchOfferedTools(buildCatalog(turn.tools, {}), approved.input.query),
				);
			}),
		callTool: (turn, use, approved) =>
			Effect.gen(function* () {
				const acting = turn.principal.value;
				const call = approved.call.value;
				const approvedTool = approved.connectorCall;
				const offered =
					acting._tag === "BotForAsker" || acting._tag === "AutomationRun"
						? find(acting, use.reach.connector.value, use.tool)
						: undefined;
				const execute = offered?.tool.execute;
				if (
					!execute ||
					approvedTool?.connectorId !== use.reach.connector.value ||
					approvedTool.tool !== use.tool ||
					approvedTool.revision !== use.reach.revision ||
					offered.connectorRevision !== use.reach.revision ||
					call.kind !== "toolCall"
				)
					return yield* new ResourceHidden({ resource: "connector" });
				return yield* Effect.promise((signal) =>
					Promise.resolve(
						execute(approvedTool.arguments, {
							toolCallId: approved.sdkToolCallId ?? call.toolCall,
							messages: [],
							abortSignal: signal,
							context: withRecordedCall(undefined, call.toolCall),
						}),
					),
				);
			}),
	});
}

function closeTurnSessions(turnId: string, turn: TurnConnectors) {
	return Effect.tryPromise(async () => {
		await Promise.all([turn.sessions.close(), turn.close()]);
	}).pipe(
		Effect.interruptible,
		Effect.timeoutOption(Duration.seconds(2)),
		Effect.flatMap((closed) =>
			Option.isNone(closed)
				? Effect.logWarning(`Connectors of turn ${turnId} did not close within 2 seconds`)
				: Effect.void,
		),
		Effect.catch((cause) =>
			Effect.logWarning(`Connectors of turn ${turnId} failed to close`, cause),
		),
	);
}

function describeCatalog({
	tools,
	close: _,
	...catalog
}: ConnectorCatalog.ConnectorToolSet): Catalog {
	return {
		...catalog,
		tools: Object.fromEntries(
			Object.entries(tools).map(([key, { tool: _, ...description }]) => [key, description]),
		),
	};
}

/** No tools, made new for each caller, since the catalog's lists can be changed. */
const emptyCatalog = (): Catalog => ({
	tools: {},
	unavailable: [],
	signInExpired: [],
	instructions: {},
	addable: [],
	fromProjectAndBot: false,
});

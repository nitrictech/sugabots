import {
	type ConnectorAccess,
	type ConnectorTool,
	connectorToolWritesOrDeletes,
} from "@sugabots/contracts";
import { ActionForbidden, BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { Effect, Result } from "effect";
import { type Executor, query } from "../database/database.ts";
import { connector, placedChat, project, projectBotConnector, turn } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { toolsOf } from "../providers/connectors/connector-store.ts";
import { toolAccessOf } from "../providers/connectors/tool-access.ts";
import {
	decideReach,
	mayInProjectAs,
	memberReaches,
	reachFacts,
	useTurnAdmission,
	whoActs,
} from "./facts.ts";
import { defineProof, type Named, named, type Proof } from "./proof.ts";

export interface ReachesEnabledConnector<P, K> extends Proof<"ReachesEnabledConnector", [P, K]> {
	readonly principal: Named<P, Principal>;
	readonly connector: Named<K, string>;
	readonly workspace: string;
	readonly project: string;
	readonly revision: number;
	readonly handle: string;
}

export interface CanUseConnector<P, K> extends Proof<"CanUseConnector", [P, K]> {
	readonly reach: ReachesEnabledConnector<P, K>;
	readonly tool: string;
	readonly writeOrDelete: boolean;
	readonly access: ConnectorAccess;
}

const ReachesEnabledConnectorProof = defineProof("ReachesEnabledConnector");
const CanUseConnectorProof = defineProof("CanUseConnector");

const connectorReach = <P, K>(principal: Named<P, Principal>, id: Named<K, string>) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "connector" });
		const [row] = isUuid(id.value)
			? yield* query((db) => enabledConnectorRows(db, principal.value, eq(connector.id, id.value)))
			: [];
		if (!row) return yield* hidden;
		const acting = principal.value;
		if (
			acting._tag === "WebhookCall" &&
			(acting.source.kind !== "github" || acting.source.connector !== id.value)
		)
			return yield* hidden;
		const mayWrite =
			acting._tag === "WebhookCall"
				? true
				: yield* connectorAccess(acting, yield* connectorPlaces(acting, row), row.workingProjectId);
		const reach: ReachesEnabledConnector<P, K> = ReachesEnabledConnectorProof.prove(
			[principal, id],
			{
				principal,
				connector: id,
				workspace: row.workspaceId,
				project: row.projectId,
				revision: row.configurationRevision,
				handle: row.handle,
			},
		);
		return { row, reach, mayWrite };
	});

function enabledConnectorRows(db: Executor, acting: Principal, selected: SQL | undefined) {
	const turn =
		acting._tag === "BotForAsker" || acting._tag === "AutomationRun" ? acting : undefined;
	return db
		.select({
			id: connector.id,
			workspaceId: connector.workspaceId,
			projectId: connector.projectId,
			configurationRevision: connector.configurationRevision,
			handle: connector.handle,
			kind: connector.kind,
			url: connector.url,
			tools: connector.tools,
			toolAccess: connector.toolAccess,
			workingProjectId: sql<string | null>`case
				when ${placedChat.projectId} = ${connector.projectId} or ${projectBotConnector.connectorId} is not null
				then ${placedChat.projectId}
			end`,
		})
		.from(connector)
		.leftJoin(placedChat, turn ? eq(placedChat.id, turn.chat) : sql`false`)
		.leftJoin(
			projectBotConnector,
			turn
				? and(
						eq(projectBotConnector.projectId, placedChat.projectId),
						eq(projectBotConnector.connectorId, connector.id),
						eq(projectBotConnector.botId, turn.bot),
						eq(projectBotConnector.addressRevision, connector.addressRevision),
					)
				: sql`false`,
		)
		.where(and(eq(connector.enabled, true), selected));
}

/** Reports why the current connector settings forbid the recorded call, if they do. */
export const checkConnectorCallSettings = (call: {
	readonly turnId: string;
	readonly connectorId: string;
	readonly connectorRevision: number | null;
	readonly remoteToolName: string | null;
}) =>
	Effect.gen(function* () {
		const { connectorRevision, remoteToolName } = call;
		if (connectorRevision === null || remoteToolName === null) return "connectorChanged";
		const [current] = yield* query((db) =>
			db
				.select({ toolAccess: connector.toolAccess })
				.from(turn)
				.innerJoin(placedChat, eq(placedChat.id, turn.chatId))
				.innerJoin(connector, eq(connector.workspaceId, placedChat.workspaceId))
				.leftJoin(
					projectBotConnector,
					and(
						eq(projectBotConnector.projectId, placedChat.projectId),
						eq(projectBotConnector.connectorId, connector.id),
						eq(projectBotConnector.botId, turn.botId),
						eq(projectBotConnector.addressRevision, connector.addressRevision),
					),
				)
				.where(
					and(
						eq(turn.id, call.turnId),
						eq(connector.id, call.connectorId),
						eq(connector.enabled, true),
						eq(connector.configurationRevision, connectorRevision),
						or(
							eq(connector.projectId, placedChat.projectId),
							isNotNull(projectBotConnector.connectorId),
						),
					),
				)
				.limit(1),
		);
		if (!current) return "connectorChanged";
		return current.toolAccess[remoteToolName] === "off" ? "toolOff" : undefined;
	});

export const checkConnectorApprovalPermission = (
	memberId: string,
	call: { readonly connectorId: string; readonly turnId: string; readonly writeOrDelete: boolean },
) =>
	Effect.gen(function* () {
		const place = yield* query((db) =>
			reachFacts(
				db,
				sql`(select case when ${project.defaultOfBotId} = ${turn.botId}
					then ${placedChat.projectId} else ${connector.projectId} end
					from ${connector}
					inner join ${project} on ${project.id} = ${connector.projectId}
					inner join ${turn} on ${turn.id} = ${call.turnId}
					inner join ${placedChat} on ${placedChat.id} = ${turn.chatId}
					where ${connector.id} = ${call.connectorId}
						and ${connector.workspaceId} = ${placedChat.workspaceId})`,
				{ member: memberId },
			),
		);
		if (
			!place?.member ||
			!memberReaches(place.member, place.project) ||
			(call.writeOrDelete && !mayInProjectAs(place.member, place.project, "project.change"))
		)
			return yield* new ActionForbidden({ proof: "CanDecide" });
	});

const connectorPlaces = (
	acting: Principal,
	{ projectId, workingProjectId }: { projectId: string; workingProjectId: string | null },
) =>
	Effect.gen(function* () {
		const who = whoActs(acting);
		const source = yield* query((db) => reachFacts(db, projectId, who));
		const own =
			source !== undefined &&
			(acting._tag === "BotForAsker" || acting._tag === "AutomationRun") &&
			acting.workspace === source.project.workspace &&
			source.project.defaultOf?.id === acting.bot;
		const working =
			own && workingProjectId && workingProjectId !== projectId
				? yield* query((db) => reachFacts(db, workingProjectId, who))
				: source;
		return { source, own, working };
	});

const connectorAccess = (
	acting: Principal,
	{ source, own, working }: Effect.Success<ReturnType<typeof connectorPlaces>>,
	workingProjectId: string | null,
) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "connector" });
		if (!source) return yield* hidden;
		const place = own ? working : source;
		if (!place) return yield* hidden;
		const admittedPlace = useTurnAdmission(acting, place);
		const { member } = admittedPlace;
		if (own) {
			if (!workingProjectId || place.project.id !== workingProjectId) return yield* hidden;
			if (acting._tag === "BotForAsker" && !memberReaches(member, admittedPlace.project))
				return yield* hidden;
		} else {
			const decision = decideReach(acting, place, undefined);
			if (decision.kind === "hidden") return yield* hidden;
			if (decision.kind === "botCannotReach")
				return yield* new BotCannotReach({ resource: "connector" });
			if (decision.as.kind === "webhook" || decision.as.kind === "systemWork")
				return yield* new ActionForbidden({ proof: "CanUseConnector" });
		}

		return (
			acting._tag === "AutomationRun" ||
			(member !== undefined && mayInProjectAs(member, admittedPlace.project, "project.change"))
		);
	});

/** The enabled revisions a turn may discover, with project standing read once for the candidates. */
export const discoverConnectorRevisions = Effect.fn("Connector.discoverRevisions")(function* (
	acting: Principal,
	workspaceId: string,
	projectId: string,
	ids: readonly string[],
) {
	const candidates = ids.filter(isUuid);
	if (candidates.length === 0) return new Map<string, number>();
	const rows = yield* query((db) =>
		enabledConnectorRows(
			db,
			acting,
			and(
				eq(connector.workspaceId, workspaceId),
				eq(connector.projectId, projectId),
				inArray(connector.id, candidates),
			),
		),
	);
	const representative = rows.find((row) => row.workingProjectId !== null) ?? rows[0];
	if (!representative) return new Map<string, number>();
	if (acting._tag === "WebhookCall") {
		return new Map(
			rows.flatMap((row) =>
				acting.source.kind === "github" && acting.source.connector === row.id
					? [[row.id, row.configurationRevision] as const]
					: [],
			),
		);
	}
	const places = yield* connectorPlaces(acting, representative);
	const allowed = yield* Effect.filter(rows, (row) =>
		connectorAccess(acting, places, row.workingProjectId).pipe(
			Effect.as(true),
			Effect.orElseSucceed(() => false),
		),
	);
	return new Map(allowed.map((row) => [row.id, row.configurationRevision]));
});

export const proveCanReachConnector = <P, K>(
	principal: Named<P, Principal>,
	id: Named<K, string>,
) => connectorReach(principal, id).pipe(Effect.map(({ reach }) => reach));

export const proveCanUseConnector = <P, K>(
	principal: Named<P, Principal>,
	connectorId: Named<K, string>,
	tool: string,
	listed?: ListedTool,
) =>
	Effect.gen(function* () {
		const facts = yield* connectorReach(principal, connectorId);
		const use = yield* Effect.fromResult(checkToolUse(facts, tool, listed));
		const proof: CanUseConnector<P, K> = CanUseConnectorProof.prove([principal, connectorId], {
			reach: facts.reach,
			tool,
			...use,
		});
		return proof;
	});

type ListedTool = {
	readonly revision: number;
	readonly described: Pick<ConnectorTool, "name" | "readOnly" | "destructive"> & {
		readonly defaultAccess?: ConnectorAccess;
	};
};

type OfferedConnectorTool = {
	readonly connectorId: string;
	readonly connectorRevision: number;
	readonly remoteToolName: string;
	readonly access: ConnectorAccess;
	readonly described: ListedTool["described"];
};

export const filterAvailableConnectorTools = <P, Tool extends OfferedConnectorTool>(
	principal: Named<P, Principal>,
	tools: Readonly<Record<string, Tool>>,
) =>
	Effect.gen(function* () {
		const byConnector = Map.groupBy(
			Object.entries(tools).filter(([, offered]) => offered.access !== "off"),
			([, offered]) => offered.connectorId,
		);
		const available = yield* Effect.forEach(byConnector, ([id, offers]) =>
			named(id, (connector) =>
				connectorReach(principal, connector).pipe(
					Effect.map((facts) =>
						offers.filter(([, offered]) => {
							const use = checkToolUse(facts, offered.remoteToolName, {
								revision: offered.connectorRevision,
								described: offered.described,
							});
							return Result.isSuccess(use) && use.success.access !== "off";
						}),
					),
					Effect.orElseSucceed(() => []),
				),
			),
		);
		return Object.fromEntries(available.flat());
	});

function checkToolUse(
	{ row, mayWrite }: Pick<Effect.Success<ReturnType<typeof connectorReach>>, "row" | "mayWrite">,
	tool: string,
	listed?: ListedTool,
): Result.Result<
	Pick<CanUseConnector<unknown, unknown>, "writeOrDelete" | "access">,
	ResourceHidden | ActionForbidden
> {
	if (listed && (listed.revision !== row.configurationRevision || listed.described.name !== tool))
		return Result.fail(new ResourceHidden({ resource: "connector" }));
	const described = (row.kind === "mcp" ? listed?.described : undefined) ??
		toolsOf(row).find((described) => described.name === tool) ?? {
			name: tool,
			description: null,
			readOnly: null,
			destructive: null,
		};
	const writeOrDelete = connectorToolWritesOrDeletes(described);
	if (writeOrDelete && !mayWrite)
		return Result.fail(new ActionForbidden({ proof: "CanUseConnector" }));
	return Result.succeed({ writeOrDelete, access: toolAccessOf(row.toolAccess, described) });
}

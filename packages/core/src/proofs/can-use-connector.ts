import {
	type ConnectorAccess,
	type ConnectorTool,
	connectorToolWritesOrDeletes,
} from "@sugabots/contracts";
import { ActionForbidden, BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { connector, placedChat, projectBotConnector } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { AutomationRun, BotForAsker, Principal } from "../principal.ts";
import { toolsOf } from "../providers/connectors/connector-store.ts";
import { toolAccessOf } from "../providers/connectors/tool-access.ts";
import { decideReach, mayInProjectAs, memberReaches, reachFacts, whoActs } from "./facts.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

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
			? yield* query((db) =>
					db
						.select({
							workspaceId: connector.workspaceId,
							projectId: connector.projectId,
							configurationRevision: connector.configurationRevision,
							handle: connector.handle,
							enabled: connector.enabled,
							kind: connector.kind,
							url: connector.url,
							addressRevision: connector.addressRevision,
							tools: connector.tools,
							toolAccess: connector.toolAccess,
						})
						.from(connector)
						.where(eq(connector.id, id.value))
						.limit(1),
				)
			: [];
		if (!row?.enabled) return yield* hidden;
		const mayWrite = yield* connectorAccess(principal.value, id.value, row);
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

const connectorAccess = (
	acting: Principal,
	id: string,
	{ projectId, addressRevision }: { readonly projectId: string; readonly addressRevision: number },
) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "connector" });
		if (acting._tag === "WebhookCall") {
			if (acting.source.kind !== "github" || acting.source.connector !== id) return yield* hidden;
			return true;
		}
		const facts = yield* query((db) => reachFacts(db, projectId, whoActs(acting)));
		if (!facts) return yield* hidden;
		const botsOwn =
			(acting._tag === "BotForAsker" || acting._tag === "AutomationRun") &&
			acting.workspace === facts.project.workspace &&
			facts.project.defaultOf?.id === acting.bot;
		if (botsOwn) {
			if (acting._tag === "BotForAsker" && !memberReaches(facts.member, facts.project))
				return yield* hidden;
			if (!(yield* onWhereTurnWorks(acting, { id, projectId, addressRevision })))
				return yield* hidden;
		} else {
			const decision = decideReach(acting, facts, undefined);
			if (decision.kind === "hidden") return yield* hidden;
			if (decision.kind === "botCannotReach")
				return yield* new BotCannotReach({ resource: "connector" });
			if (decision.as.kind === "webhook" || decision.as.kind === "systemWork")
				return yield* new ActionForbidden({ proof: "CanUseConnector" });
		}
		const member =
			acting._tag === "MemberSession" || acting._tag === "BotForAsker" ? facts.member : undefined;
		return (
			acting._tag === "AutomationRun" ||
			(member !== undefined && mayInProjectAs(member, facts.project, "project.change"))
		);
	});

/**
 * Whether the bot's own connector `connector` is on in the project its turn's
 * chat is in: always in the bot's default project, where the connector lives;
 * in any other, only once one of that project's managers turned it on there,
 * for the address revision it still has.
 */
const onWhereTurnWorks = (
	acting: BotForAsker | AutomationRun,
	connector: {
		readonly id: string;
		readonly projectId: string;
		readonly addressRevision: number;
	},
) =>
	Effect.gen(function* () {
		const [working] = yield* query((db) =>
			db
				.select({ projectId: placedChat.projectId })
				.from(placedChat)
				.where(eq(placedChat.id, acting.chat))
				.limit(1),
		);
		const workingProject = working?.projectId;
		if (!workingProject) return false;
		if (workingProject === connector.projectId) return true;
		const [turnedOn] = yield* query((db) =>
			db
				.select({ connectorId: projectBotConnector.connectorId })
				.from(projectBotConnector)
				.where(
					and(
						eq(projectBotConnector.projectId, workingProject),
						eq(projectBotConnector.connectorId, connector.id),
						eq(projectBotConnector.botId, acting.bot),
						eq(projectBotConnector.addressRevision, connector.addressRevision),
					),
				)
				.limit(1),
		);
		return turnedOn !== undefined;
	});

export const proveCanReachConnector = <P, K>(
	principal: Named<P, Principal>,
	id: Named<K, string>,
) => connectorReach(principal, id).pipe(Effect.map(({ reach }) => reach));

export const proveCanUseConnector = <P, K>(
	principal: Named<P, Principal>,
	connectorId: Named<K, string>,
	tool: string,
	listed?: {
		readonly revision: number;
		readonly described: Pick<ConnectorTool, "name" | "readOnly" | "destructive"> & {
			readonly defaultAccess?: ConnectorAccess;
		};
	},
) =>
	Effect.gen(function* () {
		const { row, reach, mayWrite } = yield* connectorReach(principal, connectorId);
		if (listed && (listed.revision !== reach.revision || listed.described.name !== tool))
			return yield* new ResourceHidden({ resource: "connector" });
		const described = (row.kind === "mcp" ? listed?.described : undefined) ??
			toolsOf(row).find((described) => described.name === tool) ?? {
				name: tool,
				description: null,
				readOnly: null,
				destructive: null,
			};
		const writeOrDelete = connectorToolWritesOrDeletes(described);
		if (writeOrDelete && !mayWrite) return yield* new ActionForbidden({ proof: "CanUseConnector" });
		const proof: CanUseConnector<P, K> = CanUseConnectorProof.prove([principal, connectorId], {
			reach,
			tool,
			writeOrDelete,
			access: toolAccessOf(row.toolAccess, described),
		});
		return proof;
	});

import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { connector, project, projectBot } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import type { CanRestrictBotsProject } from "./can-restrict-bot.ts";
import type { CanManageProject } from "./project-permissions.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import { proveReachesProject } from "./reaches-project.ts";

export interface ReachesConnector<P, J, K> extends Proof<"ReachesConnector", [P, J, K]> {
	readonly workspace: string;
	readonly project: Named<J, string>;
	readonly connector: Named<K, string>;
}

export interface CanSwitchOffConnector<P, J, K> extends Proof<"CanSwitchOffConnector", [P, J, K]> {
	readonly workspace: string;
	readonly project: Named<J, string>;
	readonly connector: Named<K, string>;
}

/**
 * K is one of the own connectors of a bot in the project J, which live in
 * the bot's default project, not J: one P, who manages J, may turn on or off
 * in J.
 */
export interface CanSetProjectBotConnector<P, J, K>
	extends Proof<"CanSetProjectBotConnector", [P, J, K]> {
	readonly workspace: string;
	readonly project: Named<J, string>;
	readonly connector: Named<K, string>;
	/** The bot whose own connector K is. */
	readonly bot: string;
	/** The member managing J, who turns it on. */
	readonly member: string;
}

const ReachesConnectorProof = defineProof("ReachesConnector");
const CanSetProjectBotConnectorProof = defineProof("CanSetProjectBotConnector");
const CanSwitchOffConnectorProof = defineProof("CanSwitchOffConnector");
const hidden = new ResourceHidden({ resource: "connector" });

export const proveReachesConnector = <P, J, K>(
	principal: Named<P, Principal>,
	projectId: Named<J, string>,
	connectorId: Named<K, string>,
) =>
	Effect.gen(function* () {
		const id = connectorId.value;
		if (!isUuid(id)) return yield* hidden;
		const reach = yield* proveReachesProject(
			principal,
			projectId,
			false,
			sql`exists (select 1 from ${connector}
				where ${connector.id} = ${id}::uuid and ${connector.projectId} = ${project.id}
				and ${connector.workspaceId} = ${project.workspaceId})`,
		).pipe(Effect.mapError(() => hidden));
		const target: ReachesConnector<P, J, K> = ReachesConnectorProof.prove(
			[principal, projectId, connectorId],
			{ workspace: reach.workspace, project: projectId, connector: connectorId },
		);
		return { reach, target };
	});

export const proveRestrictableConnector = <P, J, K>(
	canRestrict: CanRestrictBotsProject<P, J>,
	connectorId: Named<K, string>,
) =>
	Effect.gen(function* () {
		const id = connectorId.value;
		if (!isUuid(id)) return yield* hidden;
		const [found] = yield* query((db) =>
			db
				.select({ id: connector.id })
				.from(connector)
				.where(
					and(
						eq(connector.id, id),
						eq(connector.projectId, canRestrict.project.value),
						eq(connector.workspaceId, canRestrict.workspace),
					),
				),
		);
		if (!found) return yield* hidden;
		const target: CanSwitchOffConnector<P, J, K> = CanSwitchOffConnectorProof.prove(
			[canRestrict.principal, canRestrict.project, connectorId],
			{ workspace: canRestrict.workspace, project: canRestrict.project, connector: connectorId },
		);
		return target;
	});

export const proveCanSetProjectBotConnector = <P, J, K>(
	canManage: CanManageProject<P, J>,
	connectorId: Named<K, string>,
) =>
	Effect.gen(function* () {
		const id = connectorId.value;
		if (!isUuid(id)) return yield* hidden;
		const { reach } = canManage;
		const own = sql`(select ${project.defaultOfBotId} from ${project} where ${project.id} = ${connector.projectId})`;
		const [found] = yield* query((db) =>
			db
				.select({ bot: projectBot.botId })
				.from(connector)
				.innerJoin(
					projectBot,
					and(
						eq(projectBot.projectId, reach.project.value),
						eq(projectBot.workspaceId, connector.workspaceId),
						sql`${projectBot.botId} = ${own}`,
					),
				)
				.where(
					and(
						eq(connector.id, id),
						eq(connector.workspaceId, reach.workspace),
						ne(connector.projectId, reach.project.value),
					),
				)
				.limit(1),
		);
		if (!found) return yield* hidden;
		const proof: CanSetProjectBotConnector<P, J, K> = CanSetProjectBotConnectorProof.prove(
			[reach.principal, reach.project, connectorId],
			{
				workspace: reach.workspace,
				project: reach.project,
				connector: connectorId,
				bot: found.bot,
				member: canManage.member.actor.memberId,
			},
		);
		return proof;
	});

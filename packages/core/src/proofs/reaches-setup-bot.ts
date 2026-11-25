import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { bot } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { CanManageWorkspace } from "./workspace-permissions.ts";

export interface ReachesSetupBot<P, W, B> extends Proof<"ReachesSetupBot", [P, W, B]> {
	readonly workspace: Named<W, string>;
	readonly bot: Named<B, string>;
}

const ReachesSetupBotProof = defineProof("ReachesSetupBot");
const hidden = new ResourceHidden({ resource: "bot" });

export const proveReachesSetupBot = <P, W, B>(
	canManage: CanManageWorkspace<P, W>,
	botId: Named<B, string>,
) =>
	Effect.gen(function* () {
		const id = botId.value;
		if (!isUuid(id)) return yield* hidden;
		const [found] = yield* query((db) =>
			db.select({ id: bot.id }).from(bot).where(eligibleSetupBot(canManage, botId)),
		);
		if (!found) return yield* hidden;
		const { principal, workspace } = canManage.inWorkspace;
		const target: ReachesSetupBot<P, W, B> = ReachesSetupBotProof.prove(
			[principal, workspace, botId],
			{ workspace, bot: botId },
		);
		return target;
	});

export const eligibleSetupBot = <P, W, B>(
	canManage: CanManageWorkspace<P, W>,
	botId: Named<B, string>,
) =>
	and(
		eq(bot.id, botId.value),
		eq(bot.workspaceId, canManage.inWorkspace.workspace.value),
		eq(bot.createdById, canManage.actor.memberId),
		isNull(bot.systemBotKey),
	);

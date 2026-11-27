import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { Actor } from "../authorization/permissions.ts";
import { query } from "../database/database.ts";
import type { Principal } from "../principal.ts";
import { type BotRecord, botRecord, managesBot, memberReachesBot } from "./facts.ts";
import { meetBot } from "./meet-bot.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P is one of the bot B's managers: its creator, while they reach B, unless
 * now a viewer and B isn't their Personal Assistant, and an admin, for a bot
 * that isn't personal. An admin needs no reach: someone who neither manages
 * nor reaches B gets `ResourceHidden`, and someone who reaches it without
 * managing it `ActionForbidden`. A bot acting for its asker gets it only in
 * member bounds, or in its own chats for its own bot; a run never does.
 */
export interface CanManageBot<P, B> extends Proof<"CanManageBot", [P, B]> {
	readonly principal: Named<P, Principal>;
	readonly bot: Named<B, string>;
	/** B's workspace, which services take from here. */
	readonly workspace: string;
	readonly facts: BotRecord;
	/** The manager: a member signed in, or a bot's asker. */
	readonly actor: Actor;
	/**
	 * Whether a bot got this in its own chats, where it is offered only its own
	 * interview-written settings and automations.
	 */
	readonly inOwnChats: boolean;
}

const CanManageBotProof = defineProof("CanManageBot");

export const proveCanManageBot = <P, B>(principal: Named<P, Principal>, botId: Named<B, string>) =>
	Effect.gen(function* () {
		const record = yield* query((db) => botRecord(db, botId.value));
		if (!record || record.systemBot)
			return yield* Effect.fail(new ResourceHidden({ resource: "bot" }));
		const met = yield* meetBot(principal.value, record);
		const visible =
			met.kind === "run" || (met.kind === "member" && memberReachesBot(met.actor, record));
		const manages =
			met.kind === "member" && met.mayManage !== "never" && managesBot(met.actor, record);
		if (met.kind !== "member" || !manages) {
			return yield* Effect.fail(
				visible
					? new ActionForbidden({ proof: "CanManageBot" })
					: new ResourceHidden({ resource: "bot" }),
			);
		}
		const proof: CanManageBot<P, B> = CanManageBotProof.prove([principal, botId], {
			principal,
			bot: botId,
			workspace: record.workspace,
			facts: record,
			actor: met.actor,
			inOwnChats: met.mayManage === "ownChats",
		});
		return proof;
	});

/**
 * Whether the bot `principal` acts as may change itself for its asker, as
 * `proveCanManageBot` decides: asking the asker to approve a change it can't
 * make would ask in vain.
 */

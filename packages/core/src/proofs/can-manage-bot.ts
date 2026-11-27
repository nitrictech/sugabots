import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { Actor } from "../authorization/permissions.ts";
import { query } from "../database/database.ts";
import type { Principal } from "../principal.ts";
import {
	type BotRecord,
	botAtAdmission,
	botRecord,
	managesBot,
	memberReachesBot,
	whoActs,
} from "./facts.ts";
import { meetBot } from "./meet-bot.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P may manage the active bot B. Its creator manages it while they reach it
 * and have a role other than viewer, or if it is their personal bot. An
 * admin may manage a public or private bot. An admin needs no reach: someone who neither manages
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

export const checkBotManagement = (
	principal: Principal,
	botId: string,
	purpose: "settings" | "deletion",
) =>
	Effect.gen(function* () {
		const record = yield* query((db) => botRecord(db, botId, whoActs(principal)));
		if (!record || record.systemBot || (purpose === "settings" && record.deleting))
			return yield* Effect.fail(new ResourceHidden({ resource: "bot" }));
		const met = yield* meetBot(principal, record);
		const admitted = botAtAdmission(principal, record);
		const visible =
			met.kind === "run" ||
			(met.kind === "member" && admitted && memberReachesBot(met.actor, admitted));
		const manages =
			met.kind === "member" &&
			admitted &&
			met.mayManage !== "never" &&
			managesBot(met.actor, admitted);
		if (met.kind !== "member" || !manages) {
			return yield* Effect.fail(
				visible
					? new ActionForbidden({ proof: "CanManageBot" })
					: new ResourceHidden({ resource: "bot" }),
			);
		}
		return { facts: record, actor: met.actor, inOwnChats: met.mayManage === "ownChats" };
	});

export const proveCanManageBot = <P, B>(principal: Named<P, Principal>, botId: Named<B, string>) =>
	Effect.gen(function* () {
		const { facts, actor, inOwnChats } = yield* checkBotManagement(
			principal.value,
			botId.value,
			"settings",
		);
		const proof: CanManageBot<P, B> = CanManageBotProof.prove([principal, botId], {
			principal,
			bot: botId,
			workspace: facts.workspace,
			facts,
			actor,
			inOwnChats,
		});
		return proof;
	});

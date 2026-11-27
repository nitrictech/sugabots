import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import { type Actor, mayOnBot } from "../authorization/permissions.ts";
import { type CanManageBot, checkBotManagement } from "./can-manage-bot.ts";
import { proveCanRestrictBot } from "./can-restrict-bot.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { ReachesBot } from "./reaches-bot.ts";
import type { HoldsWorkspaceLock } from "./workspace-lock.ts";

/**
 * What P may do to a bot it manages, restricts or reaches. Each is proved
 * under the workspace lock.
 */

/**
 * P may delete the bot B, with its default project: one of B's managers, or
 * an admin restricting it without reaching it, a Personal Assistant included.
 * A bot in its own chats changes only its interview-written settings, so it
 * deletes nothing. Deleting it changes who reaches what, so it is proved
 * under B's workspace's lock, including when deletion has already started.
 */
export interface CanDeleteBot<P, B> extends Proof<"CanDeleteBot", [P, B]> {
	readonly bot: Named<B, string>;
	/** B's workspace, which services take from here. */
	readonly workspace: string;
	/** Whoever deletes it: a member signed in, or a bot's asker. */
	readonly actor: Actor;
}

/**
 * P may change bot B's visibility or computer use, as a manager proved
 * under B's workspace's lock.
 */
export interface CanChangeBotReach<P, B> extends Proof<"CanChangeBotReach", [P, B]> {
	readonly manage: CanManageBot<P, B>;
}

/**
 * P may invite and remove the private bot B's members: any of its members
 * but viewers, by `bot.members.manage`. A bot may only in member bounds, as
 * this changes who reaches what. Proved under B's workspace's lock, from a
 * reach proved there too.
 */
export interface CanChangeBotMembers<P, B> extends Proof<"CanChangeBotMembers", [P, B]> {
	readonly reach: ReachesBot<P, B>;
	/** The member whose permissions gave it: a member signed in, or a bot's asker. */
	readonly actor: Actor;
}

const CanDeleteBotProof = defineProof("CanDeleteBot");
const CanChangeBotReachProof = defineProof("CanChangeBotReach");
const CanChangeBotMembersProof = defineProof("CanChangeBotMembers");

export const proveCanChangeBotMembers = <P, W, B>(
	lock: HoldsWorkspaceLock<P, W>,
	reach: ReachesBot<P, B>,
): Effect.Effect<CanChangeBotMembers<P, B>, ActionForbidden | ResourceHidden> => {
	if (reach.workspace !== lock.workspace.value) {
		return Effect.fail(new ResourceHidden({ resource: "bot" }));
	}
	const actor = reach.viewer;
	const principal = reach.principal.value;
	const inMemberBounds =
		principal._tag === "MemberSession" ||
		(principal._tag === "BotForAsker" && principal.bounds.kind === "member");
	if (!actor || !inMemberBounds || !mayOnBot(actor, "bot.members.manage", reach.facts)) {
		return Effect.fail(new ActionForbidden({ proof: "CanChangeBotMembers" }));
	}
	const proof: CanChangeBotMembers<P, B> = CanChangeBotMembersProof.prove(
		[reach.principal, reach.bot],
		{ reach, actor },
	);
	return Effect.succeed(proof);
};

export const proveCanChangeBotReach = <P, W, B>(
	lock: HoldsWorkspaceLock<P, W>,
	manage: CanManageBot<P, B>,
): Effect.Effect<CanChangeBotReach<P, B>, ResourceHidden> => {
	if (manage.workspace !== lock.workspace.value) {
		return Effect.fail(new ResourceHidden({ resource: "bot" }));
	}
	const proof: CanChangeBotReach<P, B> = CanChangeBotReachProof.prove(
		[manage.principal, manage.bot],
		{ manage },
	);
	return Effect.succeed(proof);
};

export const proveCanDeleteBot = <P, W, B>(lock: HoldsWorkspaceLock<P, W>, bot: Named<B, string>) =>
	Effect.gen(function* () {
		const { principal } = lock;
		const { actor, facts, inOwnChats } = yield* checkBotManagement(
			principal.value,
			bot.value,
			"deletion",
		).pipe(
			Effect.catch(() =>
				proveCanRestrictBot(principal, bot).pipe(
					Effect.map(({ facts, actor }) => ({ facts, actor, inOwnChats: false })),
				),
			),
		);
		if (facts.workspace !== lock.workspace.value) {
			return yield* new ResourceHidden({ resource: "bot" });
		}
		if (inOwnChats) return yield* new ActionForbidden({ proof: "CanDeleteBot" });
		const proof: CanDeleteBot<P, B> = CanDeleteBotProof.prove([principal, bot], {
			bot,
			workspace: facts.workspace,
			actor,
		});
		return proof;
	});

import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { Actor, BotFacts } from "../authorization/permissions.ts";
import type { CanManageBot } from "./can-manage-bot.ts";
import type { CanRestrictBot } from "./can-restrict-bot.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { HoldsWorkspaceLock } from "./workspace-lock.ts";

/**
 * What P may do to a bot it manages or restricts. Each is a pure function of
 * `CanManageBot` or `CanRestrictBot`, with no query.
 */

/**
 * P may delete the bot B, with its default project: one of B's managers, or
 * an admin restricting it without reaching it. Nobody deletes a Personal
 * Assistant, which is its member's for as long as they are in the workspace,
 * and a bot in its own chats changes only its interview-written settings, so
 * it deletes nothing. Deleting it changes who reaches what, so it is proved
 * under B's workspace's lock, from an authority proved there too.
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

const CanDeleteBotProof = defineProof("CanDeleteBot");
const CanChangeBotReachProof = defineProof("CanChangeBotReach");

/**
 * Whether the bot may be deleted at all: anything but a Personal Assistant,
 * which is its member's for as long as they are in the workspace.
 */
export function deletable(bot: BotFacts): boolean {
	return bot.assistantOf === null;
}

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

export const proveCanDeleteBot = <P, W, B>(
	lock: HoldsWorkspaceLock<P, W>,
	authority: CanManageBot<P, B> | CanRestrictBot<P, B>,
): Effect.Effect<CanDeleteBot<P, B>, ActionForbidden | ResourceHidden> => {
	if (authority.workspace !== lock.workspace.value) {
		return Effect.fail(new ResourceHidden({ resource: "bot" }));
	}
	const inOwnChats = authority.kind === "CanManageBot" && authority.inOwnChats;
	if (!deletable(authority.facts) || inOwnChats) {
		return Effect.fail(new ActionForbidden({ proof: "CanDeleteBot" }));
	}
	const proof: CanDeleteBot<P, B> = CanDeleteBotProof.prove([authority.principal, authority.bot], {
		bot: authority.bot,
		workspace: authority.workspace,
		actor: authority.actor,
	});
	return Effect.succeed(proof);
};

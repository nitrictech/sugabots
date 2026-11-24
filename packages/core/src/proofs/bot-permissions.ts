import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { Actor } from "../authorization/permissions.ts";
import type { CanManageBot } from "./can-manage-bot.ts";
import type { CanRestrictBot } from "./can-restrict-bot.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * What P may do to a bot it manages or restricts. Each is a pure function of
 * `CanManageBot` or `CanRestrictBot`, with no query.
 */

/**
 * P may delete the bot B, with its default project: one of B's managers, or
 * an admin restricting it without reaching it. Nobody deletes a Personal
 * Assistant, which is its member's for as long as they are in the workspace,
 * and a bot in its own chats changes only its interview-written settings, so
 * it deletes nothing.
 */
export interface CanDeleteBot<P, B> extends Proof<"CanDeleteBot", [P, B]> {
	readonly bot: Named<B, string>;
	/** B's workspace, which services take from here. */
	readonly workspace: string;
	/** Whoever deletes it: a member signed in, or a bot's asker. */
	readonly actor: Actor;
}

const CanDeleteBotProof = defineProof("CanDeleteBot");

export const proveCanDeleteBot = <P, B>(
	authority: CanManageBot<P, B> | CanRestrictBot<P, B>,
): Effect.Effect<CanDeleteBot<P, B>, ActionForbidden> => {
	const inOwnChats = authority.kind === "CanManageBot" && authority.inOwnChats;
	if (authority.facts.assistantOf !== null || inOwnChats) {
		return Effect.fail(new ActionForbidden({ proof: "CanDeleteBot" }));
	}
	const proof: CanDeleteBot<P, B> = CanDeleteBotProof.prove([authority.principal, authority.bot], {
		bot: authority.bot,
		workspace: authority.workspace,
		actor: authority.actor,
	});
	return Effect.succeed(proof);
};

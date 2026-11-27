import { BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { message, placedChat } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import {
	decideReach,
	type ProjectFacts,
	type ReachedAs,
	reachFacts,
	useTurnAdmission,
	whoActs,
} from "./facts.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * The message M is in a chat P reaches, as `ReachesChat` decides it for that
 * chat. Found with the chat and its workspace, which services take from here.
 */
export interface ReachesMessage<P, M> extends Proof<"ReachesMessage", [P, M]> {
	readonly principal: Named<P, Principal>;
	readonly message: Named<M, string>;
	/** The chat M is in. */
	readonly chat: string;
	/** M's workspace. */
	readonly workspace: string;
	/** The project M's chat is in. */
	readonly project: ProjectFacts;
	readonly as: ReachedAs;
}

const ReachesMessageProof = defineProof("ReachesMessage");

export const proveReachesMessage = <P, M>(
	principal: Named<P, Principal>,
	messageId: Named<M, string>,
) =>
	Effect.gen(function* () {
		const acting = principal.value;
		const id = messageId.value;
		const hidden = new ResourceHidden({ resource: "message" });
		const [found] = isUuid(id)
			? yield* query((db) =>
					db.select({ chat: message.chatId }).from(message).where(eq(message.id, id)).limit(1),
				)
			: [];
		if (!found) return yield* Effect.fail(hidden);
		const chatsProject = sql`(select ${placedChat.projectId} from ${placedChat} where ${placedChat.id} = ${found.chat}::uuid)`;
		const facts = yield* query((db) => reachFacts(db, chatsProject, whoActs(acting)));
		if (!facts) return yield* Effect.fail(hidden);
		const decision = decideReach(acting, facts, found.chat);
		if (decision.kind === "hidden") return yield* Effect.fail(hidden);
		if (decision.kind === "botCannotReach") {
			return yield* Effect.fail(new BotCannotReach({ resource: "message" }));
		}
		const proof: ReachesMessage<P, M> = ReachesMessageProof.prove([principal, messageId], {
			principal,
			message: messageId,
			chat: found.chat,
			workspace: facts.project.workspace,
			project: useTurnAdmission(acting, facts).project,
			as: decision.as,
		});
		return proof;
	});

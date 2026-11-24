import { BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { placedChat } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { decideReach, type ProjectFacts, type ReachedAs, reachFacts, whoActs } from "./facts.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * The chat C is in a project P reaches, as `ReachesProject` decides it. System
 * work reaches only the chat its stored compaction request names; a chat in no
 * project, such as a system chat, is reached by no principal.
 */
export interface ReachesChat<P, C> extends Proof<"ReachesChat", [P, C]> {
	readonly principal: Named<P, Principal>;
	readonly chat: Named<C, string>;
	/** C's workspace, which services take from here. */
	readonly workspace: string;
	/** The project C is in. */
	readonly project: ProjectFacts;
	readonly as: ReachedAs;
}

const ReachesChatProof = defineProof("ReachesChat");

export const proveReachesChat = <P, C>(principal: Named<P, Principal>, chatId: Named<C, string>) =>
	Effect.gen(function* () {
		const acting = principal.value;
		const id = chatId.value;
		if (!isUuid(id)) return yield* Effect.fail(new ResourceHidden({ resource: "chat" }));
		const chatsProject = sql`(select ${placedChat.projectId} from ${placedChat} where ${placedChat.id} = ${id}::uuid)`;
		const facts = yield* query((db) => reachFacts(db, chatsProject, whoActs(acting)));
		if (!facts) return yield* Effect.fail(new ResourceHidden({ resource: "chat" }));
		const decision = decideReach(acting, facts, id);
		if (decision.kind === "hidden")
			return yield* Effect.fail(new ResourceHidden({ resource: "chat" }));
		if (decision.kind === "botCannotReach") {
			return yield* Effect.fail(new BotCannotReach({ resource: "chat" }));
		}
		const proof: ReachesChat<P, C> = ReachesChatProof.prove([principal, chatId], {
			principal,
			chat: chatId,
			workspace: facts.project.workspace,
			project: facts.project,
			as: decision.as,
		});
		return proof;
	});

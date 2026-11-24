import { BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { file, placedChat } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { decideReach, type ProjectFacts, type ReachedAs, reachFacts, whoActs } from "./facts.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * The file F was uploaded or made in a chat P reaches, as `ReachesChat`
 * decides it for that chat. Found with the chat and its workspace, which
 * services take from here.
 */
export interface ReachesFile<P, F> extends Proof<"ReachesFile", [P, F]> {
	readonly principal: Named<P, Principal>;
	readonly file: Named<F, string>;
	/** The chat F was uploaded or made in. */
	readonly chat: string;
	/** F's workspace. */
	readonly workspace: string;
	/** The project F's chat is in. */
	readonly project: ProjectFacts;
	readonly as: ReachedAs;
}

const ReachesFileProof = defineProof("ReachesFile");

export const proveReachesFile = <P, F>(principal: Named<P, Principal>, fileId: Named<F, string>) =>
	Effect.gen(function* () {
		const acting = principal.value;
		const id = fileId.value;
		const hidden = new ResourceHidden({ resource: "file" });
		const [found] = isUuid(id)
			? yield* query((db) =>
					db.select({ chat: file.chatId }).from(file).where(eq(file.id, id)).limit(1),
				)
			: [];
		if (!found) return yield* Effect.fail(hidden);
		const chatsProject = sql`(select ${placedChat.projectId} from ${placedChat} where ${placedChat.id} = ${found.chat}::uuid)`;
		const facts = yield* query((db) => reachFacts(db, chatsProject, whoActs(acting)));
		if (!facts) return yield* Effect.fail(hidden);
		const decision = decideReach(acting, facts, found.chat);
		if (decision.kind === "hidden") return yield* Effect.fail(hidden);
		if (decision.kind === "botCannotReach") {
			return yield* Effect.fail(new BotCannotReach({ resource: "file" }));
		}
		const proof: ReachesFile<P, F> = ReachesFileProof.prove([principal, fileId], {
			principal,
			file: fileId,
			chat: found.chat,
			workspace: facts.project.workspace,
			project: facts.project,
			as: decision.as,
		});
		return proof;
	});

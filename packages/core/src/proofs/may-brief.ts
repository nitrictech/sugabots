import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import type { Principal } from "../principal.ts";
import { actorOf, botRecord, memberReachesBot, roleIn } from "./facts.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P is a bot acting for its asker, and the asker can talk to the bot B. With
 * `Approved`, it lets a brief start B's new chat outside the turn's bounds,
 * the one write a turn makes there. Anything else is hidden: a run, which has
 * no asker, writes no brief.
 */
export interface MayBrief<P, B> extends Proof<"MayBrief", [P, B]> {
	readonly principal: Named<P, Principal>;
	readonly bot: Named<B, string>;
	/** B's workspace, which services take from here. */
	readonly workspace: string;
	/** B's default project, where its chats go when the asking chat's project doesn't have it. */
	readonly defaultProject: string;
}

const MayBriefProof = defineProof("MayBrief");

export const proveMayBrief = <P, B>(principal: Named<P, Principal>, botId: Named<B, string>) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "bot" });
		const acting = principal.value;
		if (acting._tag !== "BotForAsker") return yield* Effect.fail(hidden);
		const record = yield* query((db) => botRecord(db, botId.value));
		if (!record || record.workspace !== acting.workspace || !record.defaultProject) {
			return yield* Effect.fail(hidden);
		}
		const role = yield* query((db) => roleIn(db, record.workspace, acting.asker));
		if (!memberReachesBot(actorOf(acting.asker, role), record)) return yield* Effect.fail(hidden);
		const proof: MayBrief<P, B> = MayBriefProof.prove([principal, botId], {
			principal,
			bot: botId,
			workspace: record.workspace,
			defaultProject: record.defaultProject,
		});
		return proof;
	});

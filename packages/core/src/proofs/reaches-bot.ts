import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { Actor } from "../authorization/permissions.ts";
import { query } from "../database/database.ts";
import type { Principal } from "../principal.ts";
import { type BotRecord, botRecord, memberReachesBot } from "./facts.ts";
import { meetBot } from "./meet-bot.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P may see and talk to the bot B. A member reaches a public bot and a
 * personal bot they made, their Personal Assistants included. A bot acting for its asker
 * reaches its own bot or one within its bounds, that its asker reaches; a run,
 * its own bot or one of its project's. No other principal reaches a bot, and
 * nobody reaches a system bot.
 */
export interface ReachesBot<P, B> extends Proof<"ReachesBot", [P, B]> {
	readonly principal: Named<P, Principal>;
	readonly bot: Named<B, string>;
	/** B's workspace, which services take from here. */
	readonly workspace: string;
	readonly facts: BotRecord;
	/** The member acting, whom services show B as they see it: a member signed in, or a bot's asker; none for a run. */
	readonly viewer: Actor | undefined;
}

const ReachesBotProof = defineProof("ReachesBot");

const hidden = new ResourceHidden({ resource: "bot" });

export const proveReachesBot = <P, B>(principal: Named<P, Principal>, botId: Named<B, string>) =>
	Effect.gen(function* () {
		const record = yield* query((db) => botRecord(db, botId.value));
		if (!record || record.systemBot || record.deleting) return yield* Effect.fail(hidden);
		const met = yield* meetBot(principal.value, record);
		const reaches =
			met.kind === "run" || (met.kind === "member" && memberReachesBot(met.actor, record));
		if (!reaches) return yield* Effect.fail(hidden);
		const proof: ReachesBot<P, B> = ReachesBotProof.prove([principal, botId], {
			principal,
			bot: botId,
			workspace: record.workspace,
			facts: record,
			viewer: met.kind === "member" ? met.actor : undefined,
		});
		return proof;
	});

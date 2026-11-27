import { ApprovalNeeded, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { asksBeforeAllTools, type TurnFacts, turnFacts } from "../authentication/turn-facts.ts";
import { query } from "../database/database.ts";
import { type BriefTurnRule, bot } from "../database/schema.ts";
import type { BotForAsker, Principal } from "../principal.ts";
import {
	actorOf,
	botRecord,
	memberReaches,
	memberReachesBot,
	projectHasBot,
	reachFacts,
	roleIn,
} from "./facts.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P is a bot acting for its asker, and the asker can talk to the bot B. With
 * `Approved`, it lets a brief start B's new chat outside the turn's bounds,
 * the one write a turn makes there. Anything else is hidden: a run, which has
 * no asker, writes no brief.
 */
export interface MayBrief<P, B> extends Proof<"MayBrief", [P, B]> {
	readonly principal: Named<P, Principal>;
	readonly asker: string;
	readonly briefingBot: string;
	readonly bot: Named<B, string>;
	/** B's workspace, which services take from here. */
	readonly workspace: string;
	readonly project: string;
	readonly turnRule: BriefTurnRule | null;
}

const MayBriefProof = defineProof("MayBrief");

export const proveMayBrief = <P, B>(principal: Named<P, Principal>, botId: Named<B, string>) =>
	Effect.gen(function* () {
		const acting = principal.value;
		if (acting._tag !== "BotForAsker") return yield* new ResourceHidden({ resource: "bot" });
		const { record, turn, destination } = yield* resolveBrief(acting, botId.value);
		const turnRule =
			acting.bounds.kind === "member"
				? "memberBounds"
				: asksBeforeAllTools(turn)
					? "askBeforeAllTools"
					: null;
		const proof: MayBrief<P, B> = MayBriefProof.prove([principal, botId], {
			principal,
			bot: botId,
			workspace: record.workspace,
			asker: acting.asker,
			briefingBot: acting.bot,
			turnRule,
			project: destination,
		});
		return proof;
	});

/**
 * Fails with `ApprovalNeeded` unless the brief `mayBrief` proved still goes
 * where it was proved to go: its asker still reaches the recipient and the
 * project, and the recipient is still in the same project, the turn's while it
 * is in it, or its own otherwise. Run in the brief's write, under the
 * workspace's lock shared, so a recipient taken out of the turn's project, or
 * an asker who lost it, since the proof is seen before the chat is started.
 */
export const requireBriefDestination = <P, B>(mayBrief: MayBrief<P, B>) =>
	Effect.gen(function* () {
		const acting = mayBrief.principal.value;
		if (acting._tag !== "BotForAsker") return yield* new ResourceHidden({ resource: "bot" });
		const { destination } = yield* resolveBrief(acting, mayBrief.bot.value);
		if (destination !== mayBrief.project) return yield* new ApprovalNeeded();
	});

/**
 * Who a brief from `acting` to the bot `botId` reaches and where its chat
 * starts: the turn's project when the bot is in it, the bot's own project
 * otherwise. Hidden unless the turn may write a brief and its asker reaches
 * the bot and that project.
 */
const resolveBrief = (acting: BotForAsker, botId: string) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "bot" });
		const record = yield* query((db) => botRecord(db, botId));
		if (!record || record.workspace !== acting.workspace || !record.defaultProject) {
			return yield* Effect.fail(hidden);
		}
		const turn = yield* query((db) => turnFacts(db, acting.turn));
		if (
			!turn?.project ||
			turn.askedBy.kind !== "member" ||
			turn.askedBy.member !== acting.asker ||
			!canWriteBrief(turn.reason)
		)
			return yield* Effect.fail(hidden);
		const { project } = turn;
		const role = yield* query((db) => roleIn(db, record.workspace, acting.asker));
		if (!memberReachesBot(actorOf(acting.asker, role), record)) return yield* Effect.fail(hidden);
		const destination = (yield* query((db) => projectHasBot(db, project, record.id)))
			? project
			: record.defaultProject;
		const reach = yield* query((db) => reachFacts(db, destination, { member: acting.asker }));
		if (
			!reach ||
			reach.project.workspace !== acting.workspace ||
			!memberReaches(reach.member, reach.project)
		) {
			return yield* new ResourceHidden({ resource: "project" });
		}
		return { record, turn, destination };
	});

export function canWriteBrief(reason: TurnFacts["reason"]): boolean {
	return reason !== "collaboration" && reason !== "brief";
}

export const briefRecipient = (principal: BotForAsker, handle: string | undefined) =>
	Effect.gen(function* () {
		const [recipient] = yield* query((db) =>
			db
				.select({ id: bot.id, model: bot.model })
				.from(bot)
				.where(
					and(
						eq(bot.workspaceId, principal.workspace),
						handle === undefined
							? eq(bot.id, principal.bot)
							: and(
									sql`lower(${bot.handle}) = lower(${handle.trim().replace(/^@/, "")})`,
									or(isNull(bot.assistantOf), eq(bot.createdById, principal.asker)),
								),
					),
				)
				.limit(1),
		);
		if (!recipient) return yield* new ResourceHidden({ resource: "bot" });
		return recipient;
	});

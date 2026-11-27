import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { asksBeforeAllTools, canWriteBrief, turnFacts } from "../authentication/turn-facts.ts";
import { query } from "../database/database.ts";
import { type BriefTurnRule, bot, turn as storedTurn } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { BotForAsker, Principal } from "../principal.ts";
import {
	actorOf,
	type BotRecord,
	botAtAdmission,
	findBotRecord,
	memberReaches,
	memberReachesBot,
	projectHasBot,
	reachFacts,
	roleIn,
	useTurnAdmission,
} from "./facts.ts";
import { defineProof, type Named, named, type Proof } from "./proof.ts";

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
	readonly name: string;
	readonly model: string | null;
	/** B's workspace, which services take from here. */
	readonly workspace: string;
	readonly project: string;
	readonly projectName: string | null;
	readonly turnRule: BriefTurnRule | null;
}

const MayBriefProof = defineProof("MayBrief");

type BriefRecipient = { readonly id: string } | { readonly handle: string | undefined };

const findBriefRecipient = (acting: BotForAsker, recipient: BriefRecipient) =>
	query((db) =>
		findBotRecord(
			db,
			and(
				eq(bot.workspaceId, acting.workspace),
				"id" in recipient
					? eq(bot.id, recipient.id)
					: recipient.handle === undefined
						? eq(bot.id, acting.bot)
						: and(
								sql`lower(${bot.handle}) = lower(${recipient.handle.trim().replace(/^@/, "")})`,
								or(isNull(bot.assistantOf), eq(bot.createdById, acting.asker)),
							),
			),
			{ member: acting.asker },
		),
	);

export const briefRecipientChanged = (
	acting: BotForAsker,
	handle: string | undefined,
	approvedBot: string,
) =>
	findBriefRecipient(acting, { handle }).pipe(
		Effect.map((record) => record?.id !== approvedBot || record.deleting || !record.defaultProject),
	);

export const withBriefRecipient = <P, A, E, R>(
	principal: Named<P, Principal>,
	recipient: BriefRecipient,
	use: <B>(proof: MayBrief<P, B>) => Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		const acting = principal.value;
		const hidden = new ResourceHidden({ resource: "bot" });
		if (acting._tag !== "BotForAsker") return yield* hidden;
		if ("id" in recipient && !isUuid(recipient.id)) return yield* hidden;
		const record = yield* findBriefRecipient(acting, recipient);
		if (!record) return yield* hidden;
		const { turn, destination } = yield* resolveBrief(acting, record);
		const turnRule =
			acting.bounds.kind === "member"
				? "memberBounds"
				: asksBeforeAllTools(turn)
					? "askBeforeAllTools"
					: null;
		return yield* named(record.id, <B>(botId: Named<B, string>) => {
			const proof: MayBrief<P, B> = MayBriefProof.prove([principal, botId], {
				principal,
				bot: botId,
				name: record.name,
				model: record.model,
				workspace: record.workspace,
				asker: acting.asker,
				briefingBot: acting.bot,
				turnRule,
				project: destination.project,
				projectName: destination.projectName,
			});
			return use(proof);
		});
	});

/**
 * Who a brief from `acting` to the bot `botId` reaches and where its chat
 * starts: the turn's project when the bot is in it, the bot's own project
 * otherwise. Hidden unless the turn may write a brief and its asker reaches
 * the bot and that project.
 */
const resolveBrief = (acting: BotForAsker, record: BotRecord) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "bot" });
		if (record.deleting || !record.defaultProject) {
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
		const role = acting.admission
			? (acting.admission.role ?? undefined)
			: yield* query((db) => roleIn(db, record.workspace, acting.asker));
		const admitted = botAtAdmission(acting, record);
		const admittedToBrief =
			!admitted && acting.admission && (yield* wasBriefRecipient(acting.turn, record.id));
		if (!admittedToBrief && (!admitted || !memberReachesBot(actorOf(acting.asker, role), admitted)))
			return yield* Effect.fail(hidden);
		const inTurnProject = yield* query((db) => projectHasBot(db, project, record.id));
		if (!inTurnProject && admittedToBrief)
			return { turn, destination: { project: record.defaultProject, projectName: null } };
		const destination = inTurnProject ? project : record.defaultProject;
		const live = yield* query((db) => reachFacts(db, destination, { member: acting.asker }));
		const reach = live && useTurnAdmission(acting, live);
		if (
			!reach ||
			reach.project.workspace !== acting.workspace ||
			!memberReaches(reach.member, reach.project)
		) {
			return yield* new ResourceHidden({ resource: "project" });
		}
		return {
			turn,
			destination: {
				project: reach.project.id,
				projectName: reach.project.defaultOf ? null : reach.project.name,
			},
		};
	});

const wasBriefRecipient = (turnId: string, botId: string) =>
	query((db) =>
		db
			.select({
				admitted: sql<boolean | null>`${storedTurn.admission} -> 'briefRecipientBotIds' ? ${botId}`,
			})
			.from(storedTurn)
			.where(eq(storedTurn.id, turnId)),
	).pipe(Effect.map(([row]) => row?.admitted ?? false));

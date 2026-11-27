export * as TurnExecution from "./execution.ts";

import { helpersAskedBy, type Message, type Participant } from "@sugabots/contracts";
import { UserText, userText } from "@sugabots/errors";
import { eq, inArray, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
	type Database,
	type Executor,
	query,
	serviceOperations,
	type Transaction,
	transaction,
} from "../../database/database.ts";
import { automationRun, chatCompaction, message, turn } from "../../database/schema.ts";
import { modelAcceptsImages } from "../../providers/model-providers/model-provider-reads.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { ASSISTANT_PROMPT } from "../../workspaces/bots/assistant-prompt.ts";
import { ChatEvents } from "../chat-events.ts";
import { ChatEvent } from "../events.ts";
import { messageTextWithPlacedParts } from "../store/message-text.ts";
import {
	authorRow,
	botColumns,
	memberColumns,
	messageFromRelations,
	messageRelations,
	toParticipant,
} from "../store/participants.ts";
import {
	botsAskedBefore,
	helpersWithoutReply,
	type ReadingLimit,
	readingLimitOf,
	withinReadingLimit,
} from "./collaboration.ts";
import {
	estimatedTokens,
	historyLimitTokens,
	loadContextWindow,
	newestWithinLimit,
} from "./context-window.ts";
import { type Ended, TURN_CANCELLED } from "./lifecycle.ts";
import type { TurnSetting } from "./loop-values.ts";
import type { TurnRequest } from "./requests.ts";
import { type Abandonment, type NotRunnable, notRunnable, TurnStore } from "./store.ts";

/**
 * Running a bot's turn: one bot answering one message in a chat.
 *
 * A turn is asked for when a member posts and run by the bot loop's turn
 * workflow, one step at a time. Its run starts here, with the turn opened
 * through `TurnStore`, before the loop can authenticate the turn's principal;
 * each step then loads what the model is told here, through `RunningTurn`,
 * which proves the principal runs the turn.
 */
export interface Interface {
	/**
	 * Opens the turn for this run, or says why it may not run: its chat or bot
	 * is gone, its bot has no model, its automation run takes no more work, or
	 * newer work made it pointless. A turn this ends stays ended, so the
	 * refusal is a result rather than a failure that would roll the ending
	 * back. A refusal that ends no turn announces `TurnAbandoned`: as failed,
	 * telling members why, when they asked for a reply that cannot come, and
	 * otherwise as cancelled. Every refusal's reason is logged.
	 */
	readonly open: (run: TurnRun) => Effect.Effect<OpenedTurn | NotRunnable>;
	/**
	 * What the model is told for the turn `turnId`, loaded afresh: where it is,
	 * who it acts for, and what has been said. Its chat or bot gone is a
	 * defect, as the turn goes with them.
	 */
	readonly context: (turnId: string) => Effect.Effect<TurnContext>;
	/** The steers of the turn `turnId`: its asker's messages that reached it while it worked, oldest first. */
	readonly steers: (turnId: string) => Effect.Effect<readonly Message[]>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/TurnExecution") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("TurnExecution");
	const { emit } = yield* ChatEvents.Service;
	const turns = yield* TurnStore.Service;

	/**
	 * Ends the turn the run holds, if any, because the run may not go on, as
	 * `ending` says. With no turn to end, members are told of a failure as a
	 * notice in the chat, so nobody waits on a reply that cannot come.
	 */
	const refuseRun = (run: TurnRun, reason: string, ending: Abandonment) =>
		Effect.gen(function* () {
			const ended = yield* turns.abandon(run.executionId, { ...ending, handOnSteers: false });
			if (!ended) {
				yield* emit([
					ChatEvent.TurnAbandoned({
						chatId: run.request.chatId,
						botId: run.request.botId,
						triggerMessageId: run.request.triggerMessageId,
						reason: run.request.reason,
						outcome:
							ending.status === "failed"
								? { state: "failed", error: ending.userMessage }
								: { state: "cancelled" },
					}),
				]);
			}
			return notRunnable(reason, ended);
		});

	/**
	 * Loads what the model is told for the turn on `request`, whose reply is
	 * `replyId`, by the bot `speaker` with the model `model`, in one statement
	 * and the reads that follow from it.
	 */
	const loadContext = (
		request: TurnRequest,
		replyId: string,
		loaded: LoadedChat,
		speaker: Speaker,
		model: string,
		askerId: string | null,
	) =>
		Effect.gen(function* () {
			const windowTokens = yield* query((db) => loadContextWindow(db, loaded.workspaceId, model));
			const acceptsImages = yield* modelAcceptsImages(loaded.workspaceId, model);
			const messages = loaded.messages.reverse().map((stored) => messageFromRelations(stored));
			// The bots its reply would ask if it mentioned every one with a model.
			const modelled = (loaded.project?.bots ?? []).filter(({ model }) => model !== null);
			const askable = helpersAskedBy({
				chatKind: loaded.kind,
				authorBotId: speaker.id,
				mayAsk: request.reason !== "collaboration",
				mentionedBotIds: modelled.map(({ id }) => id),
				alreadyAsked: yield* query((db) => botsAskedBefore(db, replyId)),
			});
			const botsToAsk = modelled
				.filter(({ id }) => askable.includes(id))
				.sort((left, right) => left.name.localeCompare(right.name));
			const unanswered =
				request.reason === "hand_back"
					? yield* query((db) => helpersWithoutReply(db, request.triggerMessageId))
					: [];
			// Loaded before the history is trimmed, so what they add counts towards its limit.
			const automationInstructions = yield* query((db) => loadAutomationInstructions(db, messages));
			const history = newestWithinLimit(
				messages,
				(message) =>
					estimatedTokens(
						messageTextWithPlacedParts(message) +
							(message.automationResultOf
								? (automationInstructions.get(message.automationResultOf.runId) ?? "")
								: ""),
					),
				historyLimitTokens(windowTokens),
			);
			const context: TurnContext = {
				chat: {
					id: loaded.id,
					workspaceId: loaded.workspaceId,
					title: loaded.title,
					kind: loaded.kind,
					botId: loaded.botId,
				},
				bot: {
					id: speaker.id,
					name: speaker.name,
					handle: speaker.handle,
					model,
					acceptsImages,
					instructions: speaker.assistantOf === null ? speaker.instructions : ASSISTANT_PROMPT,
					assistantOf: speaker.assistantOf,
					visibility: speaker.visibility,
					disabledTools: speaker.disabledTools,
					usesComputer: speaker.usesComputer,
					naturalBrowsing: speaker.naturalBrowsing,
					color: speaker.color,
					defaultProjectId: speaker.defaultProject?.id ?? null,
				},
				projectId: loaded.projectId,
				reason: request.reason,
				// A bot's default project is where its own chats are, not a project members made.
				project:
					loaded.project && loaded.project.defaultOfBotId === null
						? { name: loaded.project.name, slug: loaded.project.slug }
						: null,
				workspaceName: loaded.workspace.name,
				workspaceSlug: loaded.workspace.slug,
				workspaceTimeZone: loaded.workspace.timeZone,
				askerId,
				botsToAsk: botsToAsk.map(({ id, name, handle, description }) => ({
					id,
					name,
					handle,
					description,
				})),
				helpersWithoutReply: unanswered.map(({ name, handle, status, error }) => ({
					name,
					handle,
					ended:
						status === "failed" && error !== null
							? { state: "failed", error }
							: { state: "cancelled" },
				})),
				participants: loaded.participants.map(({ member, bot }) =>
					toParticipant(authorRow(member, bot)),
				),
				windowTokens,
				compaction: loaded.compaction ?? undefined,
				messages: history,
				automationInstructions,
			};
			return context;
		});

	return Service.of({
		open: (run) =>
			operation(
				"open",
				transaction(
					Effect.gen(function* (): Effect.fn.Return<
						OpenedTurn | NotRunnable,
						never,
						Database | Transaction
					> {
						const request = run.request;
						const loaded = yield* query((db) => loadTurnContext(db, request.chatId, undefined, 0));
						if (!loaded) {
							return yield* refuseRun(run, "The chat is gone", {
								status: "cancelled",
								userMessage: TURN_CANCELLED,
								closedBecause: "chatUnavailable",
							});
						}
						const speaker = speakerIn(loaded, request.botId);
						if (!speaker) {
							return yield* refuseRun(run, "The bot does not answer in this chat", {
								status: "failed",
								userMessage: NOT_HERE,
							});
						}
						// A bot whose model has been cleared does not fall back to
						// another one: it stops, and says so, until somebody chooses.
						// Read out here so what opens the turn is handed a model rather
						// than a bot that might not carry one.
						const model = speaker.model;
						if (model === null) {
							return yield* refuseRun(run, "The bot has no model chosen", {
								status: "failed",
								userMessage: userText`${UserText.unchecked(speaker.name)} has no model chosen, so it cannot reply. Choose one in its settings.`,
							});
						}
						const opened = yield* turns.openReplyTurn({
							chatId: loaded.id,
							botId: speaker.id,
							triggerMessageId: request.triggerMessageId,
							model,
							reason: request.reason,
							executionId: run.executionId,
							author: authorRow(null, speaker),
						});
						// One whose ending was announced, now or before, isn't given up on.
						if (opened._tag === "NotRunnable" && !opened.ended && !opened.endedBefore) {
							yield* emit([
								ChatEvent.TurnAbandoned({
									chatId: request.chatId,
									botId: request.botId,
									triggerMessageId: request.triggerMessageId,
									reason: request.reason,
									outcome: { state: "cancelled" },
								}),
							]);
						}
						return opened;
					}).pipe(
						Effect.tap((opened) =>
							opened._tag === "NotRunnable"
								? Effect.logInfo(
										`Turn of bot ${run.request.botId} in chat ${run.request.chatId} may not run: ${opened.reason}`,
									)
								: Effect.void,
						),
					),
				),
			),

		context: (turnId) =>
			operation(
				"context",
				transaction(
					Effect.gen(function* () {
						const [found] = yield* query((db) =>
							db
								.select({
									chatId: turn.chatId,
									botId: turn.botId,
									triggerMessageId: turn.triggerMessageId,
									reason: turn.reason,
									model: turn.model,
									askerId: turn.askerId,
									replyId: message.id,
								})
								.from(turn)
								.innerJoin(message, eq(message.turnId, turn.id))
								.where(eq(turn.id, turnId))
								.limit(1),
						);
						if (!found?.reason) return yield* Effect.die(new Error("A running turn is gone"));
						const request: TurnRequest = {
							chatId: found.chatId,
							botId: found.botId,
							triggerMessageId: found.triggerMessageId,
							reason: found.reason,
						};
						const readingLimit = yield* query((db) => readingLimitOf(db, { ...request, turnId }));
						const loaded = yield* query((db) =>
							loadTurnContext(db, request.chatId, readingLimit, MAX_HISTORY_MESSAGES),
						);
						const speaker =
							loaded &&
							(speakerIn(loaded, request.botId) ??
								(yield* query((db) =>
									db.query.bot.findFirst({
										where: { id: request.botId, workspaceId: loaded.workspaceId },
										columns: SPEAKER_COLUMNS,
										with: SPEAKER_RELATIONS,
									}),
								)));
						if (!loaded || !speaker) {
							return yield* Effect.die(new Error("A running turn's chat or bot is gone"));
						}
						return yield* loadContext(
							request,
							found.replyId,
							loaded,
							speaker,
							found.model,
							found.askerId,
						);
					}),
				),
			),

		steers: (turnId) =>
			operation(
				"steers",
				Effect.gen(function* () {
					const [found] = yield* query((db) =>
						db.select({ steers: turn.steers }).from(turn).where(eq(turn.id, turnId)).limit(1),
					);
					const order = (found?.steers ?? []).map(({ messageId }) => messageId);
					if (order.length === 0) return [];
					const rows = yield* query((db) =>
						db.query.message.findMany({
							where: { id: { in: order }, status: "complete" },
							with: messageRelations,
						}),
					);
					const byId = new Map(rows.map((stored) => [stored.id, messageFromRelations(stored)]));
					return order.flatMap((id) => byId.get(id) ?? []);
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(TurnStore.layer));

/** One run of a turn, by the workflow execution `executionId`, which runs the turn. */
export interface TurnRun {
	readonly executionId: string;
	readonly request: TurnRequest;
}

/** A run with its turn opened. */
export interface OpenedTurn {
	readonly _tag: "Opened";
	readonly turnId: string;
	/** The bot's reply, `writing`. */
	readonly reply: Message;
}

/**
 * What the model is told about where it is and what has been said: the
 * turn's setting, which its tools are offered from, and its history.
 */
export interface TurnContext extends TurnSetting {
	/**
	 * The project's other bots this turn may ask for help by mentioning them
	 * (see `helpersAskedBy`): those with a model, not already asked for the
	 * same member's message, brief or run. None on a helper's turn, in an
	 * automation's feed, and in a bot's own chats.
	 */
	readonly botsToAsk: Array<{
		id: string;
		name: string;
		handle: string;
		description: string | null;
	}>;
	/**
	 * On a hand-back, the helpers it asked whose turns ended without a reply,
	 * and how; none on any other turn.
	 */
	readonly helpersWithoutReply: Array<{ name: string; handle: string; ended: Ended }>;
	readonly participants: Participant[];
	/** The context window the bot's model is treated as having, which every limit is a share of. */
	readonly windowTokens: number;
	/**
	 * The newest completed messages, oldest first: those since the compaction
	 * kept them word for word, as many as fit the bot's history limit.
	 */
	readonly messages: Message[];
	/**
	 * What each automation run whose result is among `messages` was told to do,
	 * by the run's id, so the bot can say why a result was posted. Each is
	 * cut to `MAX_AUTOMATION_INSTRUCTION_CHARACTERS`, ending in an ellipsis when cut.
	 */
	readonly automationInstructions: ReadonlyMap<string, string>;
}

/**
 * How much of an automation run's instructions a result in the history carries:
 * enough to say why it was posted, while an automation's feed of results
 * repeats them for every run.
 */
const MAX_AUTOMATION_INSTRUCTION_CHARACTERS = 1_000;

/** The instructions of the automation runs whose results are among `messages`, by run id. */
const loadAutomationInstructions = Effect.fn("TurnExecution.loadAutomationInstructions")(function* (
	db: Executor,
	messages: readonly Message[],
) {
	const runIds = messages.flatMap((message) =>
		message.automationResultOf ? [message.automationResultOf.runId] : [],
	);
	if (runIds.length === 0) return new Map<string, string>();
	const runs = yield* db
		.select({
			id: automationRun.id,
			// One more than is kept, to tell a cut from an exact fit.
			instructions: sql<string>`left(${automationRun.instructions}, ${MAX_AUTOMATION_INSTRUCTION_CHARACTERS + 1})`,
		})
		.from(automationRun)
		.where(inArray(automationRun.id, runIds));
	return new Map(
		runs.map((run) => [
			run.id,
			run.instructions.length > MAX_AUTOMATION_INSTRUCTION_CHARACTERS
				? `${run.instructions.slice(0, MAX_AUTOMATION_INSTRUCTION_CHARACTERS)}…`
				: run.instructions,
		]),
	);
});

/**
 * The most messages loaded for a turn, before they are cut to the bot's
 * history limit. It bounds the query, not what the bot reads.
 */
const MAX_HISTORY_MESSAGES = 1_000;

/** What members are told when a bot asked to reply in a chat is not in its project. */
const NOT_HERE = userText`The bot asked to reply doesn't answer here, so it cannot reply.`;

const SPEAKER_COLUMNS = {
	id: true,
	name: true,
	handle: true,
	description: true,
	color: true,
	eyes: true,
	shape: true,
	model: true,
	instructions: true,
	disabledTools: true,
	usesComputer: true,
	naturalBrowsing: true,
	assistantOf: true,
	visibility: true,
} as const;

/** Its default project, whose connectors it brings to every project it works in. */
const SPEAKER_RELATIONS = { defaultProject: { columns: { id: true } } } as const;

/**
 * Everything the model is told about the chat, in one statement: the
 * chat with its workspace, its project and the bots in it or the bot it is
 * with, the members and bots in it, its compaction, and its newest completed
 * messages since the compaction kept them, within `readingLimit` when given,
 * with the parts placed in them.
 */
const loadTurnContext = Effect.fn("TurnExecution.loadTurnContext")(function* (
	db: Executor,
	chatId: string,
	readingLimit: ReadingLimit | undefined,
	/** The most messages to load, newest first. */
	messageLimit: number,
) {
	return yield* db.query.placedChat.findFirst({
		where: { id: chatId },
		columns: {
			id: true,
			workspaceId: true,
			projectId: true,
			botId: true,
			title: true,
			kind: true,
		},
		with: {
			workspace: { columns: { name: true, slug: true, timeZone: true } },
			project: {
				columns: { id: true, name: true, slug: true, defaultOfBotId: true },
				with: { bots: { columns: SPEAKER_COLUMNS, with: SPEAKER_RELATIONS } },
			},
			bot: { columns: SPEAKER_COLUMNS, with: SPEAKER_RELATIONS },
			participants: {
				columns: {},
				orderBy: { createdAt: "asc", id: "asc" },
				with: { member: memberColumns, bot: botColumns },
			},
			compaction: { columns: { condensed: true, historyStartsAt: true, keptFrom: true } },
			// The reply being written is `writing`, so this leaves it out.
			messages: {
				where: {
					status: "complete",
					RAW: (row) =>
						sql`${row.createdAt} >= coalesce((select ${chatCompaction.keptFrom} from ${chatCompaction} where ${chatCompaction.chatId} = ${row.chatId}), '-infinity')
							and ${readingLimit === undefined ? sql`true` : withinReadingLimit(row, readingLimit)}`,
				},
				orderBy: { createdAt: "desc", id: "desc" },
				limit: messageLimit,
				with: messageRelations,
			},
		},
	});
});

/** A chat as `loadTurnContext` loads it. */
type LoadedChat = NonNullable<Effect.Success<ReturnType<typeof loadTurnContext>>>;

/** A bot that may answer in a loaded chat. */
type Speaker = NonNullable<LoadedChat["bot"]>;

/**
 * The bot `botId` as it answers in `loaded`: in a project it has to be one
 * of the project's, whoever a mention picks; in a bot's own chat, it has to
 * be that bot. This is what stops a turn request naming a bot from elsewhere.
 */
function speakerIn(loaded: LoadedChat, botId: string): Speaker | undefined {
	if (loaded.project) return loaded.project.bots.find(({ id }) => id === botId);
	return loaded.bot?.id === botId ? loaded.bot : undefined;
}

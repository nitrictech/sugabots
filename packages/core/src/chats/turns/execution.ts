export * as TurnExecution from "./execution.ts";

import {
	type BotColor,
	type BotVisibility,
	type ChatKind,
	helpersAskedBy,
	type Message,
	type Participant,
} from "@sugabots/contracts";
import { UserText, userText } from "@sugabots/errors";
import { inArray, type SQLWrapper, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
	type Database,
	type Executor,
	query,
	serviceOperations,
	type Transaction,
	transaction,
} from "../../database/database.ts";
import { automationRun, chatCompaction, message, type TurnReason } from "../../database/schema.ts";
import { modelAcceptsImages } from "../../providers/model-providers/model-provider-reads.ts";
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
	turnAskingFor,
} from "./collaboration.ts";
import {
	estimatedTokens,
	historyLimitTokens,
	loadContextWindow,
	newestWithinLimit,
} from "./context-window.ts";
import { type Ended, TURN_CANCELLED } from "./lifecycle.ts";
import {
	type NotRunnable,
	notRunnable,
	type ReplyTurn,
	type TurnCheckpoint,
	TurnStore,
} from "./store.ts";
import { answersAlone, Turn, type TurnRequest } from "./turn.workflow.ts";

/**
 * Running a bot's turn: one bot answering one message in a chat.
 *
 * A turn is asked for when a member posts and run by the turn workflow (see
 * `turn.workflow.ts`), one segment at a time. Each segment starts here, with
 * the turn opened through `TurnStore` and what the model is told loaded.
 * It runs for the workflow, not for a member, so it asks for no actor and is
 * never handed to a route.
 */
export interface Interface {
	/**
	 * Opens the turn for this run and loads what the model needs, or says why
	 * it may not run: its chat or bot is gone, its bot has no model, its
	 * automation run takes no more work, or newer work made it pointless. A turn
	 * this ends stays ended, so the refusal is a result rather than a failure
	 * that would roll the ending back. A refusal that ends no turn announces
	 * `TurnAbandoned`: as failed, telling members why, when they asked for a
	 * reply that cannot come, and otherwise as cancelled. Every refusal's
	 * reason is logged.
	 */
	readonly prepare: (run: TurnRun) => Effect.Effect<PreparedTurn | NotRunnable>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/TurnExecution",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("TurnExecution");
	const { emit } = yield* ChatEvents.Service;
	const turns = yield* TurnStore.Service;

	/**
	 * Ends the turn the run holds, if any, because the run may not go on, as
	 * `ending` says. With no turn to end, members are told of a failure as a
	 * notice in the chat, so nobody waits on a reply that cannot come.
	 */
	const refuseRun = (
		run: TurnRun,
		reason: string,
		ending: { status: "failed" | "cancelled"; userMessage: UserText },
	) =>
		Effect.gen(function* () {
			const ended = yield* turns.abandon(run.executionId, ending);
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

	return Service.of({
		prepare: (run) =>
			operation(
				"prepare",
				transaction(
					Effect.gen(function* (): Effect.fn.Return<
						PreparedTurn | NotRunnable,
						never,
						Database | Transaction
					> {
						const request = run.request;
						const readingLimit = yield* query((db) => readingLimitOf(db, request));
						const loaded = yield* query((db) => loadTurnContext(db, request.chatId, readingLimit));
						if (!loaded) return yield* refuseRun(run, "The chat is gone", CANCELLED);
						// In a project the bot has to be one of the project's, whoever a
						// mention picks; in a bot's own chat, it has to be that bot.
						// This is what stops a turn request naming a bot from elsewhere.
						const speaker = loaded.project
							? loaded.project.bots.find(({ id }) => id === request.botId)
							: loaded.bot?.id === request.botId
								? loaded.bot
								: undefined;
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
						if (opened._tag === "NotRunnable") {
							if (!opened.ended) {
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
						}
						const windowTokens = yield* query((db) =>
							loadContextWindow(db, loaded.workspaceId, model),
						);
						const acceptsImages = yield* modelAcceptsImages(loaded.workspaceId, model);
						const messages = loaded.messages
							.reverse()
							.map((stored) => messageFromRelations(stored));
						const trigger = messages.find(({ id }) => id === request.triggerMessageId);
						// A helper and a hand-back act for the asker of the turn whose
						// reply asked, or its run.
						const askingFor = answersAlone(request.reason)
							? yield* query((db) => turnAskingFor(db, request.triggerMessageId))
							: {
									reason: request.reason,
									askerId: trigger?.author.kind === "member" ? trigger.author.id : null,
								};
						// The bots its reply would ask if it mentioned every one with a model.
						const modelled = (loaded.project?.bots ?? []).filter(({ model }) => model !== null);
						const askable = helpersAskedBy({
							chatKind: loaded.kind,
							authorBotId: speaker.id,
							mayAsk: request.reason !== "collaboration",
							mentionedBotIds: modelled.map(({ id }) => id),
							alreadyAsked: yield* query((db) => botsAskedBefore(db, opened.reply.id)),
						});
						const botsToAsk = modelled
							.filter(({ id }) => askable.includes(id))
							.sort((left, right) => left.name.localeCompare(right.name));
						const unanswered =
							request.reason === "hand_back"
								? yield* query((db) => helpersWithoutReply(db, request.triggerMessageId))
								: [];
						// Loaded before the history is trimmed, so what they add counts towards its limit.
						const automationInstructions = yield* query((db) =>
							loadAutomationInstructions(db, messages),
						);
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
						return {
							_tag: "Prepared",
							run,
							turnId: opened.turnId,
							responseMessage: opened.reply,
							context: {
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
									instructions:
										speaker.assistantOf === null ? speaker.instructions : ASSISTANT_PROMPT,
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
								askerId: askingFor?.askerId ?? null,
								startedFor: askingFor?.reason === "brief" ? loaded.startedById : null,
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
							},
							...(opened.checkpoint ? { checkpoint: opened.checkpoint } : {}),
						};
					}).pipe(
						Effect.tap((preparation) =>
							preparation._tag === "NotRunnable"
								? Effect.logInfo(
										`Turn of bot ${run.request.botId} in chat ${run.request.chatId} may not run: ${preparation.reason}`,
									)
								: Effect.void,
						),
					),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(TurnStore.layer));

/** One run of a turn, by the workflow execution `executionId`, which runs the turn. */
export interface TurnRun {
	readonly executionId: string;
	readonly request: TurnRequest;
}

/** The turn workflow's run of the turn `request` asks for. */
export const turnRunFor = (request: TurnRequest) =>
	Effect.map(
		Turn.executionId(request),
		(executionId): TurnRun => ({
			executionId,
			request,
		}),
	);

/** A run with its turn opened and its context loaded, ready to stream. */
export interface PreparedTurn {
	readonly _tag: "Prepared";
	readonly run: TurnRun;
	readonly turnId: string;
	/** The bot's reply, `writing` and empty until the segment streams into it. */
	readonly responseMessage: Message;
	readonly context: TurnContext;
	/** Where a suspended turn left off; set only when this run continues it. */
	readonly checkpoint?: TurnCheckpoint;
}

/** Where the prepared turn and its reply are, for recording how it goes. */
export function replyTurnOf(prepared: PreparedTurn): ReplyTurn {
	return {
		turnId: prepared.turnId,
		chatId: prepared.context.chat.id,
		workspaceId: prepared.context.chat.workspaceId,
		botId: prepared.context.bot.id,
		messageId: prepared.responseMessage.id,
	};
}

/** What the model is told about where it is and what has been said. */
export interface TurnContext {
	chat: {
		id: string;
		workspaceId: string;
		title: string;
		kind: ChatKind;
		/** The bot the chat is with; none in a project members made. */
		botId: string | null;
	};
	bot: {
		id: string;
		name: string;
		handle: string;
		model: string;
		/** Whether its model takes images, which tools can then show it. */
		acceptsImages: boolean;
		/** What it is told to be: its own instructions, or for a Personal Assistant, Sugabots'. */
		instructions: string;
		/** On a Personal Assistant: the one member it works for. */
		assistantOf: string | null;
		/** Whether everyone in the workspace reaches it, or only its creator. */
		visibility: BotVisibility;
		/** Built-in tools an admin switched off for this bot, by key. */
		disabledTools: string[];
		/** Whether somebody let this bot use a computer. */
		usesComputer: boolean;
		/** Whether it browses so members watching its desktop can follow. */
		naturalBrowsing: boolean;
		/** Its colour, which its desktop in the computer is drawn in. */
		color: BotColor;
		/** Its default project, whose connectors it brings wherever it works; none for a system bot. */
		defaultProjectId: string | null;
	};
	/**
	 * The project whose computer, connectors and automations the turn works
	 * with: the one its chat, automation feed or run is in. None for a system
	 * bot.
	 */
	projectId: string | null;
	/** Why this bot has the turn. */
	reason: TurnReason;
	/**
	 * The project members made that the chat is in, by name and slug;
	 * none in a bot's own chat, its chats in its default project
	 * included.
	 */
	project: { name: string; slug: string } | null;
	workspaceName: string;
	workspaceSlug: string;
	/** The workspace's timezone, which the routines the bot sets up run in. */
	workspaceTimeZone: string;
	/**
	 * The member whose message this turn answers, who the bot acts for when
	 * it changes something on their behalf: for a helper or a hand-back, the
	 * asker of the turn whose reply asked. None when it answers a bot's brief
	 * or an automation's trigger.
	 */
	askerId: string | null;
	/**
	 * On a bot's brief, the member the bot started the chat for, as on the
	 * helpers and hand-backs of the turn answering it. The bot may mark this
	 * chat resolved for them, and nothing more: the brief is a bot's words, not
	 * theirs, so it never vouches for anything else they could do, such as
	 * starting another chat or changing instructions.
	 */
	startedFor: string | null;
	/**
	 * The project's other bots this turn may ask for help by mentioning them
	 * (see `helpersAskedBy`): those with a model, not already asked for the
	 * same member's message, brief or run. None on a helper's turn, in an
	 * automation's feed, and in a bot's own chats.
	 */
	botsToAsk: Array<{ id: string; name: string; handle: string; description: string | null }>;
	/**
	 * On a hand-back, the helpers it asked whose turns ended without a reply,
	 * and how; none on any other turn.
	 */
	helpersWithoutReply: Array<{ name: string; handle: string; ended: Ended }>;
	participants: Participant[];
	/** The context window the bot's model is treated as having, which every limit is a share of. */
	windowTokens: number;
	/** What the Compaction bot left in place of older history, once the chat has been compacted. */
	compaction: TurnCompaction | undefined;
	/**
	 * The newest completed messages, oldest first: those since the compaction
	 * kept them word for word, as many as fit the bot's history limit.
	 */
	messages: Message[];
	/**
	 * What each automation run whose result is among `messages` was told to do,
	 * by the run's id, so the bot can say why a result was posted. Each is
	 * cut to `MAX_AUTOMATION_INSTRUCTION_CHARACTERS`, ending in an ellipsis when cut.
	 */
	automationInstructions: ReadonlyMap<string, string>;
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

export interface TurnCompaction {
	/** The Compaction bot's condensed account of the messages from `historyStartsAt` to `keptFrom`. */
	condensed: string;
	/** History before this is neither condensed nor read, only searched. */
	historyStartsAt: Date;
	/** Where the messages the bot reads word for word start. */
	keptFrom: Date;
}

/**
 * The most messages loaded for a turn, before they are cut to the bot's
 * history limit. It bounds the query, not what the bot reads.
 */
const MAX_HISTORY_MESSAGES = 1_000;

/** How a run is refused whose reply nobody needs any more. */
const CANCELLED = { status: "cancelled", userMessage: TURN_CANCELLED } as const;

/** What members are told when a bot asked to reply in a chat is not in its project. */
const NOT_HERE = userText`The bot asked to reply doesn't answer here, so it cannot reply.`;

/**
 * Whether the message `row` is within `limit`: no later in its chat than the
 * message `limit.upTo`, in the order the chat shows them, or written by the
 * reading turn's own bot.
 */
const within = (
	row: { createdAt: SQLWrapper; id: SQLWrapper; authorBotId: SQLWrapper },
	limit: ReadingLimit,
) =>
	sql`((${row.createdAt}, ${row.id}) <= (select ${message.createdAt}, ${message.id} from ${message} where ${message.id} = ${limit.upTo})
		or ${row.authorBotId} = ${limit.ownBotId})`;

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
			startedById: true,
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
							and ${readingLimit === undefined ? sql`true` : within(row, readingLimit)}`,
				},
				orderBy: { createdAt: "desc", id: "desc" },
				limit: MAX_HISTORY_MESSAGES,
				with: messageRelations,
			},
		},
	});
});

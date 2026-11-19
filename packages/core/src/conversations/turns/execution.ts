export * as TurnExecution from "./execution.ts";

import type {
	BotColor,
	BotVisibility,
	ConversationKind,
	Message,
	Participant,
} from "@sugabots/contracts";
import { UserText, userText } from "@sugabots/errors";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { computerProjectIdOf } from "../../authorization/access.ts";
import {
	type Database,
	type Executor,
	query,
	serviceOperations,
	type Transaction,
	transaction,
} from "../../database/database.ts";
import {
	automationRun,
	bot,
	conversationCompaction,
	type TurnReason,
} from "../../database/schema.ts";
import { modelAcceptsImages } from "../../providers/model-providers/model-provider-reads.ts";
import { ASSISTANT_PROMPT } from "../../workspaces/bots/assistant-prompt.ts";
import { ConversationEvents } from "../conversation-events.ts";
import { ConversationEvent } from "../events.ts";
import { messageTextWithPlacedParts } from "../repository/message-text.ts";
import {
	authorRow,
	botColumns,
	messageFromRelations,
	messageRelations,
	personColumns,
	toParticipant,
} from "../repository/participants.ts";
import {
	estimatedTokens,
	historyLimitTokens,
	loadContextWindow,
	newestWithinLimit,
} from "./context-window.ts";
import { type Ended, TURN_CANCELLED } from "./lifecycle.ts";
import {
	type NotRunnable,
	type ReplyTurn,
	type TurnCheckpoint,
	TurnRepository,
} from "./repository.ts";
import { storedTurn, Turn, type TurnRequest } from "./turn.workflow.ts";

/**
 * Running a bot's turn: one bot answering one message in a conversation.
 *
 * A turn is asked for when a person posts and run by the turn workflow (see
 * `turn.workflow.ts`), one segment at a time. Each segment starts here, with
 * the turn opened through `TurnRepository` and what the model is told loaded.
 * It runs for the workflow, not for a person, so it asks for no actor and is
 * never handed to a route; a person asking a turn to stop is
 * `TurnCancellation`.
 */
export interface Interface {
	/**
	 * Opens the turn for this run and loads what the model needs, or says why
	 * it may not run: its conversation or bot is gone, its bot has no model, its
	 * automation run takes no more work, or newer work made it pointless. A turn
	 * this ends stays ended, so the refusal is a result rather than a failure
	 * that would roll the ending back. A refusal that ends no turn announces
	 * `TurnAbandoned`: as failed, telling people why, when they asked for a
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
	const { emit } = yield* ConversationEvents.Service;
	const turns = yield* TurnRepository.Service;

	/**
	 * Ends the turn the run holds, if any, because the run may not go on, as
	 * `ending` says. With no turn to end, people are told of a failure as a
	 * notice in the conversation, so nobody waits on a reply that cannot come.
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
					ConversationEvent.TurnAbandoned({
						conversationId: run.request.conversationId,
						botId: run.request.botId,
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
						const loaded = yield* query((db) =>
							loadTurnContext(db, request.conversationId, request.botId),
						);
						if (!loaded) return yield* refuseRun(run, "The conversation is gone", CANCELLED);
						// In a project the bot has to be one of the project's, whoever a
						// mention picks; in a bot's own conversation, it has to be that bot. A
						// direct message between people has no bot at all. This is what
						// stops a turn request naming a bot from elsewhere.
						const speaker = loaded.project
							? loaded.project.bots.find(({ id }) => id === request.botId)
							: loaded.bot?.id === request.botId
								? loaded.bot
								: undefined;
						if (!speaker) {
							return yield* refuseRun(run, "The bot does not answer in this conversation", {
								status: "failed",
								userMessage: NOT_HERE,
							});
						}
						const collaborators = yield* query((db) =>
							collaboratorsOf(db, loaded.workspaceId, speaker.id),
						);
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
							conversationId: loaded.id,
							botId: speaker.id,
							triggerMessageId: request.triggerMessageId,
							model,
							reason: request.reason,
							owner: run.executionId,
							author: authorRow(null, speaker),
						});
						if (opened._tag === "NotRunnable") {
							if (!opened.ended) {
								yield* emit([
									ConversationEvent.TurnAbandoned({
										conversationId: request.conversationId,
										botId: request.botId,
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
								conversation: {
									id: loaded.id,
									workspaceId: loaded.workspaceId,
									title: loaded.title,
									kind: loaded.kind,
									botId: loaded.botId,
									parentConversationId: loaded.parentConversationId,
								},
								bot: {
									id: speaker.id,
									name: speaker.name,
									handle: speaker.handle,
									model,
									acceptsImages,
									prompt: speaker.assistantOf === null ? speaker.prompt : ASSISTANT_PROMPT,
									assistantOf: speaker.assistantOf,
									visibility: speaker.visibility,
									disabledTools: speaker.disabledTools,
									usesComputer: speaker.usesComputer,
									naturalBrowsing: speaker.naturalBrowsing,
									color: speaker.color,
									defaultProjectId: speaker.defaultProject?.id ?? null,
								},
								projectId: loaded.computerProjectId,
								reason: request.reason,
								// A bot's default project is where its own threads are, not a project people made.
								project:
									loaded.project && loaded.project.defaultOfBotId === null
										? { name: loaded.project.name, slug: loaded.project.slug }
										: null,
								workspaceName: loaded.workspace.name,
								workspaceSlug: loaded.workspace.slug,
								workspaceTimeZone: loaded.workspace.timeZone,
								askedBy: trigger?.author.kind === "person" ? trigger.author.id : null,
								startedFor: request.reason === "brief" ? loaded.startedById : null,
								collaborators,
								participants: loaded.participants.map(({ user, bot }) =>
									toParticipant(authorRow(user, bot)),
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
										`Turn of bot ${run.request.botId} in conversation ${run.request.conversationId} may not run: ${preparation.reason}`,
									)
								: Effect.void,
						),
					),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(TurnRepository.layer));

/** One run of a turn, by the workflow execution `executionId`, which owns the turn. */
export interface TurnRun {
	readonly executionId: string;
	readonly request: TurnRequest;
}

/** The turn workflow's run of the turn `request` asks for. */
export const turnRunFor = (request: TurnRequest) =>
	Effect.map(
		Turn.executionId(storedTurn(request)),
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
	/** The bot's reply, `streaming` and empty until the segment streams into it. */
	readonly responseMessage: Message;
	readonly context: TurnContext;
	/** Where a suspended turn left off; set only when this run continues it. */
	readonly checkpoint?: TurnCheckpoint;
}

/** Where the prepared turn and its reply are, for recording how it goes. */
export function replyTurnOf(prepared: PreparedTurn): ReplyTurn {
	return {
		turnId: prepared.turnId,
		conversationId: prepared.context.conversation.id,
		workspaceId: prepared.context.conversation.workspaceId,
		botId: prepared.context.bot.id,
		reason: prepared.run.request.reason,
		messageId: prepared.responseMessage.id,
	};
}

/** What the model is told about where it is and what has been said. */
export interface TurnContext {
	conversation: {
		id: string;
		workspaceId: string;
		title: string;
		kind: ConversationKind;
		/** The bot the conversation is with; none in a project's thread or between people. */
		botId: string | null;
		/** Set when another bot opened this conversation by asking this one for help. */
		parentConversationId: string | null;
	};
	bot: {
		id: string;
		name: string;
		handle: string;
		model: string;
		/** Whether its model takes images, which tools can then show it. */
		acceptsImages: boolean;
		/** What it is told to be: its own instructions, or for a Personal Assistant, Sugabots'. */
		prompt: string;
		/** On a Personal Assistant: the one person it works for. */
		assistantOf: string | null;
		/** Whether everyone in the workspace reaches it, or only its creator. */
		visibility: BotVisibility;
		/** Built-in tools an admin switched off for this bot, by key. */
		disabledTools: string[];
		/** Whether somebody let this bot use a computer. */
		usesComputer: boolean;
		/** Whether it browses so people watching its desktop can follow. */
		naturalBrowsing: boolean;
		/** Its colour, which its desktop in the computer is drawn in. */
		color: BotColor;
		/** Its default project, whose connections it brings wherever it works; none for a system bot. */
		defaultProjectId: string | null;
	};
	/**
	 * The project whose computer, connections and automations the turn works
	 * with: the one its thread, automation feed or run is in, or for a
	 * collaboration the bot's own default project. None for a system bot.
	 */
	projectId: string | null;
	/** Why this bot has the turn, when the trigger recorded it. */
	reason: TurnReason | undefined;
	/**
	 * The project people made that the conversation is in, by name and slug;
	 * none in a bot's own conversation, its threads in its default project
	 * included.
	 */
	project: { name: string; slug: string } | null;
	workspaceName: string;
	workspaceSlug: string;
	/** The workspace's timezone, which the routines the bot sets up run in. */
	workspaceTimeZone: string;
	/**
	 * The person whose message this turn answers, who the bot acts for when
	 * it changes something on their behalf. None when it answers a bot, a
	 * bot's brief, or an automation's trigger.
	 */
	askedBy: string | null;
	/**
	 * On a bot's brief, the person the bot started the conversation for. The bot
	 * may mark this conversation done for them, and nothing more: the brief is a
	 * bot's words, not theirs, so it never vouches for anything else they could
	 * do, such as starting another conversation or changing instructions.
	 */
	startedFor: string | null;
	/** The workspace's other bots, which this one may ask for help. */
	collaborators: Array<{ id: string; name: string; handle: string; description: string | null }>;
	participants: Participant[];
	/** The context window the bot's model is treated as having, which every limit is a share of. */
	windowTokens: number;
	/** What the Compaction bot left in place of older history, once the conversation has been compacted. */
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
	/** The Compaction bot's summary of the messages from `historyStartsAt` to `keptFrom`. */
	summary: string;
	/** History before this is neither summarised nor read, only searched. */
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

/** What people are told when a bot asked to reply in a conversation is not in its project. */
const NOT_HERE = userText`The bot asked to reply doesn't answer here, so it cannot reply.`;

/**
 * The bots `botId` may ask for help: every other bot of the workspace that
 * people talk to, but not a Personal Assistant, which is its person's alone.
 */
const collaboratorsOf = (db: Executor, workspaceId: string, botId: string) =>
	db
		.select({
			id: bot.id,
			name: bot.name,
			handle: bot.handle,
			description: bot.description,
		})
		.from(bot)
		.where(
			and(
				eq(bot.workspaceId, workspaceId),
				ne(bot.id, botId),
				isNull(bot.systemBotKey),
				isNull(bot.assistantOf),
			),
		)
		.orderBy(asc(bot.name));

function notRunnable(reason: string, ended?: Ended): NotRunnable {
	return { _tag: "NotRunnable", reason, ended };
}

const SPEAKER_COLUMNS = {
	id: true,
	name: true,
	handle: true,
	color: true,
	face: true,
	shape: true,
	model: true,
	prompt: true,
	disabledTools: true,
	usesComputer: true,
	naturalBrowsing: true,
	assistantOf: true,
	visibility: true,
} as const;

/** Its default project, whose connections it brings to every project it works in. */
const SPEAKER_RELATIONS = { defaultProject: { columns: { id: true } } } as const;

/**
 * Everything the model is told about the conversation, in one statement: the
 * conversation with its workspace, its project and the bots in it or the bot it is
 * with, the project whose computer and connections the turn of `botId` uses, the
 * people and bots in it, its compaction, and its newest completed messages since
 * the compaction kept them, with the parts placed in them.
 */
const loadTurnContext = Effect.fn("TurnExecution.loadTurnContext")(function* (
	db: Executor,
	conversationId: string,
	botId: string,
) {
	return yield* db.query.placedConversation.findFirst({
		where: { id: conversationId },
		extras: {
			computerProjectId: (row) => computerProjectIdOf(row, sql`${botId}::uuid`),
		},
		columns: {
			id: true,
			workspaceId: true,
			projectId: true,
			parentConversationId: true,
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
				with: { user: personColumns, bot: botColumns },
			},
			compaction: { columns: { summary: true, historyStartsAt: true, keptFrom: true } },
			// The reply being written is `streaming`, so this leaves it out.
			messages: {
				where: {
					status: "complete",
					RAW: (row) =>
						sql`${row.createdAt} >= coalesce((select ${conversationCompaction.keptFrom} from ${conversationCompaction} where ${conversationCompaction.conversationId} = ${row.conversationId}), '-infinity')`,
				},
				orderBy: { createdAt: "desc", id: "desc" },
				limit: MAX_HISTORY_MESSAGES,
				with: messageRelations,
			},
		},
	});
});

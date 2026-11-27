export * as Chats from "./chats.ts";

import type {
	AutomationFeed,
	BotStartedChat,
	Message,
	ProjectChat,
	StartedChat,
} from "@sugabots/contracts";
import {
	BotHasNoModel,
	type MessageRetryKeyConflict,
	type ReplyTargetNotFound,
	type UnsentAttachmentsNotFound,
} from "@sugabots/contracts/errors/chats";
import { ApprovalRefused, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, isNotNull, isNull, notExists } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import {
	automation,
	bot,
	OPENABLE_CHAT_KINDS,
	type PlacedChatRow,
	placedChat,
	project,
} from "../../database/schema.ts";
import { Ids } from "../../ids/ids.ts";
import type { Approved } from "../../proofs/approved.ts";
import type { CanManageBot } from "../../proofs/can-manage-bot.ts";
import type { CanManageChats } from "../../proofs/chat-permissions.ts";
import type { IsMember } from "../../proofs/is-member.ts";
import type { MayBrief } from "../../proofs/may-brief.ts";
import type { CanChangeChat, CanTakePart } from "../../proofs/project-permissions.ts";
import type { Named } from "../../proofs/proof.ts";
import type { ReachesAutomation } from "../../proofs/reaches-automation.ts";
import type { ReachesBot } from "../../proofs/reaches-bot.ts";
import type { ReachesChat } from "../../proofs/reaches-chat.ts";
import type { ReachesProject } from "../../proofs/reaches-project.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { INTERVIEW_PROMPT } from "../../workspaces/bots/interview-prompt.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { FloorControl } from "../floor/floor-control.ts";
import { memberColumns } from "../store/participants.ts";
import { ChatStore } from "../store/store.ts";
import { holdTurnOf, type ToolWriteRefusal, Turns } from "../turns/turns.ts";
import { toAutomationFeed, toProjectChat } from "./chat.ts";
import { chatTitleFrom } from "./chat-title.ts";
import { reachedChatOfKind } from "./reached-chat.ts";

/**
 * Talking in chats, for operations that have proved what each call needs:
 * members start chats, in projects and with bots, post in them and read them,
 * and whoever has the floor after a message is asked to speak. Each method
 * takes the chat, project or workspace from its proofs, and the member from
 * `IsMember`.
 */
export interface Interface {
	/**
	 * Starts the chat in which the bot `canManage` is about interviews the
	 * member, who made it and talks to it, to write its own instructions: once,
	 * while it still has the interview's instructions, a model and no chats.
	 * Null when it is not due one, as for a manager who didn't make it.
	 */
	readonly startInterview: <P, B>(
		isMember: IsMember<P>,
		reach: ReachesBot<P, B>,
		canManage: CanManageBot<P, B>,
	) => Effect.Effect<ProjectChat | null>;
	/**
	 * Starts a chat for the member in the project `reach` is about, for
	 * everyone in it, titled from its first message, which whoever has the
	 * floor answers: the lead bot, unless it mentions others. A bot's chats are
	 * started in its default project. Refused when a bot given the floor has
	 * no model. Starting it again with the same message returns the chat it
	 * started. Files are added once it has started, since an upload belongs to
	 * a chat.
	 */
	readonly startProjectChat: <P, J>(
		isMember: IsMember<P>,
		reach: ReachesProject<P, J>,
		first: { retryKey: string; content: string },
	) => Effect.Effect<StartedChat, BotHasNoModel | MessageRetryKeyConflict>;
	/** Renames the project's chat `reach` is about to `name`. Any other chat is hidden from this. */
	readonly renameChat: <P, C>(
		reach: ReachesChat<P, C>,
		name: string,
		canManage: CanManageChats<P, C>,
	) => Effect.Effect<void, ResourceHidden>;
	/**
	 * The automation's feed, where its runs post, opened on
	 * first use. `reach` identifies the automation and its workspace.
	 */
	readonly openAutomationFeed: <P, A>(
		automationId: Named<A, string>,
		reach: ReachesAutomation<P, A>,
	) => Effect.Effect<AutomationFeed, ResourceHidden>;
	/**
	 * Posts the member's message in the chat `canTakePart` is about, with the
	 * files they uploaded to it, and gives the floor. Posting the same message
	 * again returns it unchanged. Only a chat members open, a project's chat or
	 * an automation's feed, takes messages; any other is hidden from this.
	 */
	readonly post: <P, C>(
		isMember: IsMember<P>,
		canTakePart: CanTakePart<P, C>,
		posted: {
			retryKey: string;
			/** May be empty when the message carries files. */
			content: string;
			/** Ids of the member's uploads to the chat, not yet sent. None unless set. */
			attachments?: readonly string[];
			/** The id of the message in the chat that this one quotes and answers. */
			replyTo?: string;
		},
	) => Effect.Effect<
		Message,
		| ResourceHidden
		| MessageRetryKeyConflict
		| ReplyTargetNotFound
		| UnsentAttachmentsNotFound
		| BotHasNoModel
	>;
	/**
	 * Marks the project's chat `reach` is about resolved, or reopens it. An
	 * automation's feed is never resolved, so it is hidden from this.
	 */
	readonly setResolved: <P, C, X>(
		reach: ReachesChat<P, C>,
		canChange: CanChangeChat<P, C>,
		approved: Approved<P, X, [C], "chats.setResolved">,
	) => Effect.Effect<void, ResourceHidden | ToolWriteRefusal>;
	readonly startBriefedChat: <P, B, X>(
		mayBrief: MayBrief<P, B>,
		approved: Approved<P, X, [B], "chats.startBriefedChat">,
	) => Effect.Effect<
		BotStartedChat,
		ApprovalRefused | BotHasNoModel | ResourceHidden | ToolWriteRefusal
	>;
	/**
	 * Records that the member has read the chat `reach` is about up to its
	 * newest finished message. Only a chat members open; any other is hidden.
	 */
	readonly markRead: <P, C>(
		isMember: IsMember<P>,
		reach: ReachesChat<P, C>,
	) => Effect.Effect<void, ResourceHidden>;
	/**
	 * Records that the member has read one automation run, opened as a page of
	 * its own, by its own chat, which `reach` is about, leaving the chat it is
	 * listed in, and what was written in the run's chat since it began,
	 * unread. Other chats are hidden from this.
	 */
	readonly markNestedChatRead: <P, C>(
		isMember: IsMember<P>,
		reach: ReachesChat<P, C>,
	) => Effect.Effect<void, ResourceHidden>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Chats") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Chats");
	const chats = yield* ChatStore.Service;
	const floor = yield* FloorControl.Service;
	const turns = yield* Turns.Service;
	const ids = yield* Ids.Service;

	/** The bot `botId`, when `memberId` made it and it is still due its interview: it has no chats. */
	const dueInterview = (botId: string, memberId: string) =>
		Effect.map(
			query((db) =>
				db
					.select({ id: bot.id, name: bot.name, workspaceId: bot.workspaceId })
					.from(bot)
					.where(
						and(
							eq(bot.id, botId),
							eq(bot.createdById, memberId),
							eq(bot.instructions, INTERVIEW_PROMPT),
							isNotNull(bot.model),
							notExists(
								db
									.select({ id: placedChat.id })
									.from(placedChat)
									.where(and(eq(placedChat.kind, "project_chat"), eq(placedChat.botId, botId))),
							),
						),
					)
					.limit(1),
			),
			([row]) => row,
		);

	/**
	 * Posts `memberId`'s message in `chat`, which they have been found to
	 * reach, and gives the floor. Posting the same message again returns it
	 * unchanged.
	 */
	const postIn = <P, C>(
		chat: PlacedChatRow,
		memberId: string,
		poster: ReachesChat<P, C> | undefined,
		input: {
			retryKey: string;
			content: string;
			attachments?: readonly string[];
			replyTo?: string;
		},
	) =>
		Effect.gen(function* () {
			const posted = yield* chats.post({
				retryKey: input.retryKey,
				chatId: chat.id,
				author: yield* authorOf(memberId),
				content: input.content,
				replyTo: input.replyTo,
				attachments: input.attachments ?? [],
			});
			if (posted._tag === "AlreadyPosted") return posted.message;
			// Something new in a resolved chat is not left where nobody looks.
			yield* chats.setResolved(chat, false);
			// Given once the message is known to be new, so sending it again
			// still returns it; a refusal rolls the post back.
			yield* floor.giveFloor(
				{ id: posted.message.id, chatId: chat.id, content: posted.message.content },
				poster,
			);
			return posted.message;
		});

	/**
	 * Starts a chat for `memberId` in the project `place.projectId`, titled
	 * from its first message, and posts it, giving the floor. Sent again with the same message, it
	 * returns the chat that key started in the project for that member.
	 */
	const startWithMessage = Effect.fnUntraced(function* (
		place: { workspaceId: string; projectId: string },
		memberId: string,
		input: { retryKey: string; content: string },
	) {
		const chat = yield* chats.startChat({
			...place,
			startedById: memberId,
			startRetryKey: input.retryKey,
			title: chatTitleFrom(input.content),
		});
		// A chat just started has no turn for its first message to steer.
		const posted = yield* postIn(chat, memberId, undefined, input).pipe(
			// It neither quotes a message nor carries files, so neither can be missing.
			Effect.catchTags({ ReplyTargetNotFound: Effect.die, UnsentAttachmentsNotFound: Effect.die }),
		);
		return { chat: toProjectChat(chat), message: posted };
	});

	return Service.of({
		startInterview: (isMember, _reach, canManage) =>
			operation(
				"startInterview",
				transaction(
					Effect.gen(function* () {
						const due = yield* dueInterview(canManage.bot.value, isMember.member);
						if (!due) return null;
						const interview = yield* chats.startChat({
							workspaceId: canManage.workspace,
							projectId: yield* defaultProjectOf(due.id),
							startedById: isMember.member,
							title: `Setting up ${due.name}`,
						});
						yield* turns.ask({
							chatId: interview.id,
							botId: due.id,
							triggerMessageId: yield* ids.next,
							reason: "interview",
						});
						return toProjectChat(interview);
					}),
				),
			),

		startProjectChat: (isMember, reach, first) =>
			operation(
				"startProjectChat",
				transaction(
					startWithMessage(
						{ workspaceId: reach.workspace, projectId: reach.project.value },
						isMember.member,
						first,
					),
				),
			),

		renameChat: (reach, name, _canManage) =>
			operation(
				"renameChat",
				Effect.flatMap(reachedChatOfKind(reach, ["project_chat"]), (chat) =>
					chats.renameChat(chat, name),
				),
			),

		openAutomationFeed: (automationId, reach) =>
			operation(
				"openAutomationFeed",
				transaction(
					Effect.gen(function* () {
						const [owned] = yield* query((db) =>
							db
								.select({ automation, leadBotId: project.leadBotId })
								.from(automation)
								.innerJoin(project, eq(project.id, automation.projectId))
								.where(
									and(
										eq(automation.id, automationId.value),
										eq(automation.workspaceId, reach.workspace),
										isNull(automation.deletedAt),
									),
								)
								.limit(1),
						);
						if (!owned) return yield* new ResourceHidden({ resource: "automation" });
						return toAutomationFeed(
							yield* chats.openAutomationFeed(owned.automation, owned.leadBotId),
						);
					}),
				),
			),

		post: (isMember, canTakePart, posted) =>
			operation(
				"post",
				transaction(
					Effect.flatMap(reachedChatOfKind(canTakePart.reach, OPENABLE_CHAT_KINDS), (chat) =>
						postIn(chat, isMember.member, canTakePart.reach, posted),
					),
				),
			),

		startBriefedChat: (mayBrief, approved) =>
			operation(
				"startBriefedChat",
				transaction(
					Effect.gen(function* () {
						const principal = approved.principal.value;
						const call = approved.call.value;
						if (
							principal._tag !== "BotForAsker" ||
							call.kind !== "toolCall" ||
							approved.decidedBy !== mayBrief.asker
						) {
							return yield* new ApprovalRefused();
						}
						yield* holdTurnOf(principal, { project: mayBrief.project, permission: "project.read" });
						const botId = mayBrief.bot.value;
						const [recipient] = yield* query((db) =>
							db
								.select({ name: bot.name, model: bot.model })
								.from(bot)
								.where(and(eq(bot.id, botId), eq(bot.workspaceId, mayBrief.workspace)))
								.limit(1),
						);
						if (!recipient) return yield* new ResourceHidden({ resource: "bot" });
						if (recipient.model === null) return yield* new BotHasNoModel();
						const { title, brief } = approved.input;
						const started = yield* chats.startBriefedChat({
							title,
							brief,
							workspaceId: mayBrief.workspace,
							projectId: mayBrief.project,
							recipientBotId: botId,
							startedById: mayBrief.asker,
							briefingBotId: mayBrief.briefingBot,
							briefTurnRule: mayBrief.turnRule,
							startRetryKey: call.toolCall,
						});
						return {
							id: started.id,
							title: started.title,
							...(botId !== principal.bot && { with: recipient.name, withBotId: botId }),
						};
					}),
				),
			),

		setResolved: (reach, _canChange, approved) =>
			operation(
				"setResolved",
				transaction(
					Effect.gen(function* () {
						const principal = approved.principal.value;
						yield* holdTurnOf(principal, {
							project: reach.project.id,
							permission: "project.change",
						});
						const chat = yield* reachedChatOfKind(reach, ["project_chat"]);
						yield* chats.setResolved(chat, approved.input.resolved);
					}),
				),
			),

		markRead: (isMember, reach) =>
			operation(
				"markRead",
				transaction(
					Effect.flatMap(reachedChatOfKind(reach, OPENABLE_CHAT_KINDS), (chat) =>
						chats.markRead(isMember.member, chat.id),
					),
				),
			),

		markNestedChatRead: (isMember, reach) =>
			operation(
				"markNestedChatRead",
				transaction(
					Effect.flatMap(reachedChatOfKind(reach, ["run"]), (chat) =>
						chats.markNestedChatRead(isMember.member, chat.id),
					),
				),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

/**
 * Over the chat services it gives the floor and asks turns of, which
 * `ChatServices.layer` composes with the events they emit.
 */
export const layer = layerNoDeps.pipe(Layer.provide(ChatStore.layer));

/** The member `memberId` as the author of their messages. */
const authorOf = (memberId: string) =>
	Effect.flatMap(
		query((db) => db.query.member.findFirst({ where: { id: memberId }, ...memberColumns })),
		(author) =>
			author ? Effect.succeed(author) : Effect.die(new Error("The member has no account")),
	);

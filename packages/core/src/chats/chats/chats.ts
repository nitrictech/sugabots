export * as Chats from "./chats.ts";

import type { AutomationFeed, Message, ProjectChat, StartedChat } from "@sugabots/contracts";
import {
	type BotHasNoModel,
	MessageIdConflict,
	type ReplyTargetNotFound,
	type UnsentAttachmentsNotFound,
} from "@sugabots/contracts/errors/chats";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, getColumns, isNotNull, isNull, notExists } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import {
	automation,
	bot,
	message,
	OPENABLE_CHAT_KINDS,
	type PlacedChatRow,
	placedChat,
	project,
} from "../../database/schema.ts";
import { Ids, isUuid } from "../../ids/ids.ts";
import type { CanManageBot } from "../../proofs/can-manage-bot.ts";
import type { CanManageChats } from "../../proofs/chat-permissions.ts";
import type { IsMember } from "../../proofs/is-member.ts";
import type { CanChangeChat, CanTakePart } from "../../proofs/project-permissions.ts";
import type { ReachSet } from "../../proofs/reach-set.ts";
import type { ReachesChat } from "../../proofs/reaches-chat.ts";
import type { ReachesProject } from "../../proofs/reaches-project.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { INTERVIEW_PROMPT } from "../../workspaces/bots/interview-prompt.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { FloorControl } from "../floor/floor-control.ts";
import { memberColumns } from "../store/participants.ts";
import { ChatStore, lockMessageId } from "../store/store.ts";
import { Turns } from "../turns/turns.ts";
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
	 * member, who made it, to write its own instructions: once, while it still
	 * has the interview's instructions, a model and no chats. Null when it is
	 * not due one, as for a manager who didn't make it.
	 */
	readonly startInterview: <P, B>(
		isMember: IsMember<P>,
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
		first: { messageId: string; content: string },
	) => Effect.Effect<StartedChat, BotHasNoModel | MessageIdConflict>;
	/** Renames the project's chat `reach` is about to `name`. Any other chat is hidden from this. */
	readonly renameChat: <P, C>(
		reach: ReachesChat<P, C>,
		name: string,
		canManage: CanManageChats<P, C>,
	) => Effect.Effect<void, ResourceHidden>;
	/**
	 * The automation `automationId`'s feed, where its runs post, opened on
	 * first use. Hidden unless it is an automation of the workspace in a
	 * project `reach` reaches.
	 */
	readonly openAutomationFeed: <P, W>(
		reach: ReachSet<P, W>,
		automationId: string,
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
			messageId: string;
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
		| MessageIdConflict
		| ReplyTargetNotFound
		| UnsentAttachmentsNotFound
		| BotHasNoModel
	>;
	/**
	 * Marks the project's chat `reach` is about resolved, or reopens it. An
	 * automation's feed is never resolved, so it is hidden from this.
	 */
	readonly setResolved: <P, C>(
		reach: ReachesChat<P, C>,
		resolved: boolean,
		canChange: CanChangeChat<P, C>,
	) => Effect.Effect<void, ResourceHidden>;
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
	const postIn = (
		chat: PlacedChatRow,
		memberId: string,
		input: {
			messageId: string;
			content: string;
			attachments?: readonly string[];
			replyTo?: string;
		},
	) =>
		Effect.gen(function* () {
			const posted = yield* chats.post({
				id: input.messageId,
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
			yield* floor.giveFloor({
				id: posted.message.id,
				chatId: chat.id,
				content: posted.message.content,
			});
			return posted.message;
		});

	/**
	 * Starts a chat for `memberId` in the project `place.projectId`, titled
	 * from its first message, and posts it, giving the floor. Sent again with the same message, it
	 * returns the chat that message started instead, unless that is elsewhere.
	 */
	const startWithMessage = Effect.fnUntraced(function* (
		place: { workspaceId: string; projectId: string },
		memberId: string,
		input: { messageId: string; content: string },
	) {
		// A retry waits for the first send, and then finds the chat it started.
		yield* lockMessageId(input.messageId);
		const [sent] = isUuid(input.messageId)
			? yield* query((db) =>
					db
						.select({ chat: getColumns(placedChat) })
						.from(message)
						.innerJoin(placedChat, eq(placedChat.id, message.chatId))
						.where(and(eq(message.id, input.messageId), eq(message.authorMemberId, memberId)))
						.limit(1),
				)
			: [];
		if (sent && (sent.chat.kind !== "project_chat" || sent.chat.projectId !== place.projectId)) {
			return yield* new MessageIdConflict();
		}
		const chat =
			sent?.chat ??
			(yield* chats.startChat({
				workspaceId: place.workspaceId,
				projectId: place.projectId,
				startedById: memberId,
				title: chatTitleFrom(input.content),
			}));
		const posted = yield* postIn(chat, memberId, input).pipe(
			// It neither quotes a message nor carries files, so neither can be missing.
			Effect.catchTags({ ReplyTargetNotFound: Effect.die, UnsentAttachmentsNotFound: Effect.die }),
		);
		return { chat: toProjectChat(chat), message: posted };
	});

	return Service.of({
		startInterview: (isMember, canManage) =>
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

		openAutomationFeed: (reach, automationId) =>
			operation(
				"openAutomationFeed",
				transaction(
					Effect.gen(function* () {
						const [owned] = isUuid(automationId)
							? yield* query((db) =>
									db
										.select({ automation, leadBotId: project.leadBotId })
										.from(automation)
										.innerJoin(project, eq(project.id, automation.projectId))
										.where(
											and(
												eq(automation.id, automationId),
												eq(automation.workspaceId, reach.workspace.value),
												isNull(automation.deletedAt),
												reach.reachesProject(automation.projectId),
											),
										)
										.limit(1),
								)
							: [];
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
						postIn(chat, isMember.member, posted),
					),
				),
			),

		setResolved: (reach, resolved, _canChange) =>
			operation(
				"setResolved",
				transaction(
					// Only a project's chat is ever resolved, not an automation's feed.
					Effect.flatMap(reachedChatOfKind(reach, ["project_chat"]), (chat) =>
						chats.setResolved(chat, resolved),
					),
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

import {
	type ChatHistoryQuery,
	type ChatPageQuery,
	DEFAULT_CHAT_HISTORY_LIMIT,
	DEFAULT_CHAT_PAGE_LIMIT,
	type ToolApprovalDecision,
} from "@sugabots/contracts";
import type { UploadInterrupted } from "@sugabots/contracts/errors/chats";
import type { InputOf, RequestOperationName } from "@sugabots/contracts/operations";
import type { Stream } from "effect";
import type { MemberSession } from "../../principal.ts";
import { signedIn } from "../../proofs/world.test-support.ts";
import type { CallOperation } from "../testing.ts";

export { signedIn };

/**
 * What `memberId`, signed in, does in chats through the HTTP API, each a call
 * of its operation through `call`: for cases that set up chats, messages and
 * decisions the way members make them, and read what members read. Signs in
 * on the first call.
 */
export function asMember(call: CallOperation, memberId: string) {
	let session: Promise<MemberSession> | undefined;
	const as = async <Name extends RequestOperationName>(name: Name, input: InputOf<Name>) => {
		session ??= signedIn(memberId);
		return call(await session, name, input);
	};
	return {
		/** The member's principal, signed in. */
		principal: () => {
			session ??= signedIn(memberId);
			return session;
		},
		startInterview: (botId: string) => as("chats.startInterview", { botId }),
		openAutomationFeed: (input: { workspace: string; automationId: string }) =>
			as("chats.openAutomationFeed", input),
		startProjectChat: (input: InputOf<"chats.startProjectChat">) =>
			as("chats.startProjectChat", input),
		renameChat: (input: { chatId: string; name: string }) => as("chats.renameChat", input),
		setResolved: (input: { chatId: string; resolved: boolean }) => as("chats.setResolved", input),
		markRead: (chatId: string) => as("chats.markRead", { chatId }),
		markNestedChatRead: (chatId: string) => as("chats.markNestedChatRead", { chatId }),
		send: (input: InputOf<"chats.send">) => as("chats.send", input),
		/** Reactions to messages, by the message's id. */
		reactions: {
			add: (messageId: string, emoji: string) => as("chats.react", { messageId, emoji }),
			remove: (messageId: string, emoji: string) => as("chats.unreact", { messageId, emoji }),
		},
		/** The member's uploads to a chat, and the files sent on its messages. */
		chatFiles: {
			upload: (input: {
				chatId: string;
				name: string;
				type: string | undefined;
				stream: Stream.Stream<Uint8Array, UploadInterrupted>;
			}) =>
				as("chats.uploadFile", {
					chatId: input.chatId,
					name: input.name,
					...(input.type !== undefined && { type: input.type }),
					content: input.stream,
				}),
			removeUnsentAttachment: (input: { chatId: string; fileId: string }) =>
				as("chats.removeFile", input),
			read: (input: { chatId: string; fileId: string }) => as("chats.file", input),
		},
		chats: (projectId: string) => as("chats.projectChats", { projectId }),
		attention: (workspace: string) => as("chats.attention", { workspace }),
		attentionMarks: (workspace: string) => as("chats.attentionMarks", { workspace }),
		approvals: (workspace: string) => as("chats.approvals", { workspace }),
		messages: (chatId: string, page: ChatPageQuery = { limit: DEFAULT_CHAT_PAGE_LIMIT }) =>
			as("chats.messages", { chatId, ...page }),
		history: (chatId: string, page: ChatPageQuery = { limit: DEFAULT_CHAT_PAGE_LIMIT }) =>
			as("chats.history", { chatId, ...page }),
		get: (chatId: string, history: ChatHistoryQuery = { limit: DEFAULT_CHAT_HISTORY_LIMIT }) =>
			as("chats.get", { chatId, ...history }),
		context: (chatId: string) => as("chats.context", { chatId }),
		decide: (input: { toolCallId: string; decision: ToolApprovalDecision["decision"] }) =>
			as("approvals.decide", input),
		interruptTurn: (input: { chatId: string; turnId: string }) => as("chats.interruptTurn", input),
		/** The files in chats: those bots wrote, by their ids. */
		files: {
			listInProject: (projectId: string) => as("files.listInProject", { projectId }),
			get: (fileId: string) => as("files.get", { fileId }),
			versions: (fileId: string) => as("files.versions", { fileId }),
			getVersion: (fileId: string, version: number) => as("files.getVersion", { fileId, version }),
			pageAddress: (fileId: string, version: number) =>
				as("files.pageAddress", { fileId, version }),
			remove: (fileId: string) => as("files.remove", { fileId }),
		},
	};
}

export type AsMember = ReturnType<typeof asMember>;

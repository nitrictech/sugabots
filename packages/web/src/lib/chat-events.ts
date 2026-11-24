import {
	type ChatDetails,
	type ChatRead,
	chatUpdateEventSchema,
	isAttached,
	type MemberParticipant,
	type Message,
	type MessagePart,
	messagePartsFor,
	type PlacedPart,
	placedParts,
	type StreamEvent,
	workspaceUpdateEventSchema,
} from "@sugabots/contracts";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect, Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { client } from "@/api.ts";
import { refreshAutomations } from "@/lib/automations.ts";
import { refreshAfterChatChange, refreshListsAndAttention } from "@/lib/chats.ts";
import { refreshFilesAfter } from "@/lib/files.ts";
import { changeReactions } from "@/lib/reactions.ts";
import { useWorkspace } from "@/lib/workspace.ts";

export function useChatEvents(chatId: string | undefined): void {
	const queries = useQueryClient();

	useEffect(() => {
		if (!chatId) return;
		const stream = client.events.chat(chatId);
		void consume(stream, (event) => applyChatEvent(queries, chatId, event)).catch(() => {
			void queries.invalidateQueries({ queryKey: ["chat", chatId] });
		});
		return () => stream.close();
	}, [queries, chatId]);
}

/** Something the chat's events told its watchers that no message records. */
export interface ChatNotice {
	id: string;
	text: string;
}

/**
 * What the chat's events have said since its last new message that no
 * message records, oldest first: why a reply somebody asked for is not
 * coming. Kept only while the chat is watched, since the server keeps
 * notices in no chat's history.
 */
export function useChatNotices(chatId: string | undefined): readonly ChatNotice[] {
	return (
		useQuery({
			queryKey: noticesKey(chatId ?? ""),
			queryFn: (): ChatNotice[] => [],
			enabled: chatId !== undefined,
			staleTime: Number.POSITIVE_INFINITY,
		}).data ?? []
	);
}

const noticesKey = (chatId: string) => ["chat-notices", chatId] as const;

/** How often a member still typing says so again. */
const TYPING_SIGNAL_INTERVAL_MS = 3_000;

/**
 * How long a member is shown typing after they last said so. Long enough for
 * the next signal to arrive late without them flickering out.
 */
const TYPING_SHOWN_FOR_MS = 2 * TYPING_SIGNAL_INTERVAL_MS;

/** A member the chat's events said is typing, and until when they are shown. */
interface TypingMember {
	member: MemberParticipant;
	/** Epoch milliseconds. */
	shownUntil: number;
}

const typingKey = (chatId: string) => ["chat-typing", chatId] as const;

/**
 * Tells the chat's other watchers the current user is typing when `draft` changes
 * to text, at most once per `TYPING_SIGNAL_INTERVAL_MS`. A draft kept from an
 * earlier visit is not typing until it is edited. An emptied draft, as after
 * sending, lets the next keystroke say so straight away.
 */
export function useTypingSignal(chatId: string | undefined, draft: string): void {
	const lastSentAt = useRef(0);
	const previousDraft = useRef(draft);

	useEffect(() => {
		const edited = draft !== previousDraft.current;
		previousDraft.current = draft;
		if (!chatId || !edited) return;
		if (!draft.trim()) {
			lastSentAt.current = 0;
			return;
		}
		const now = Date.now();
		if (now - lastSentAt.current < TYPING_SIGNAL_INTERVAL_MS) return;
		lastSentAt.current = now;
		// Best effort: a lost signal only means the dots show a moment late.
		void Effect.runPromise(client.api.events.typing({ params: { chatId } })).catch(() => {});
	}, [chatId, draft]);
}

/**
 * The members typing in the chat, other than `memberId`, in the order they
 * started. Each drops out once their signals stop or their message arrives.
 */
export function useMembersTyping(
	chatId: string | undefined,
	memberId: string,
): readonly MemberParticipant[] {
	const typing =
		useQuery({
			queryKey: typingKey(chatId ?? ""),
			queryFn: (): TypingMember[] => [],
			enabled: chatId !== undefined,
			staleTime: Number.POSITIVE_INFINITY,
		}).data ?? [];
	const [now, setNow] = useState(Date.now);
	const shown = typing.filter(
		({ member, shownUntil }) => member.id !== memberId && shownUntil > now,
	);
	const nextExpiry = Math.min(...shown.map(({ shownUntil }) => shownUntil));

	useEffect(() => {
		if (!Number.isFinite(nextExpiry)) return;
		const timer = setTimeout(() => setNow(Date.now()), nextExpiry - Date.now());
		return () => clearTimeout(timer);
	}, [nextExpiry]);

	return shown.map(({ member }) => member);
}

/** `typing` with `member` shown for another `TYPING_SHOWN_FOR_MS`, and without anyone expired. */
function withMemberTyping(typing: TypingMember[], member: MemberParticipant): TypingMember[] {
	const now = Date.now();
	const shownUntil = now + TYPING_SHOWN_FOR_MS;
	const current = typing.filter((entry) => entry.shownUntil > now);
	return current.some((entry) => entry.member.id === member.id)
		? current.map((entry) => (entry.member.id === member.id ? { member, shownUntil } : entry))
		: [...current, { member, shownUntil }];
}

export function useWorkspaceEvents(): void {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	useEffect(() => {
		if (!workspaceId) {
			return;
		}
		const stream = client.events.workspace(workspaceId);
		// A stream that drops may have missed a new message, so the lists are fetched afresh.
		void consume(stream, (event) => applyWorkspaceEvent(queries, workspaceId, event)).catch(() => {
			void refreshListsAndAttention(queries, workspaceId);
		});
		return () => stream.close();
	}, [queries, workspaceId]);
}

function upsertChatMessage(details: ChatDetails, incoming: Message): ChatDetails {
	return {
		...details,
		messages: mergeChatMessages(details.messages, [incoming]),
	};
}

export function mergeChatMessages(current: Message[], incoming: Message[]): Message[] {
	const messages = new Map(current.map((message) => [message.id, message]));
	for (const message of incoming) {
		messages.set(message.id, message);
	}
	return [...messages.values()].sort((left, right) => {
		if (left.createdAt !== right.createdAt) {
			return left.createdAt < right.createdAt ? -1 : 1;
		}
		return left.id < right.id ? -1 : left.id === right.id ? 0 : 1;
	});
}

async function consume(
	stream: AsyncIterable<StreamEvent>,
	apply: (event: StreamEvent) => void | Promise<void>,
): Promise<void> {
	for await (const event of stream) {
		await apply(event);
	}
}

async function applyChatEvent(
	queries: QueryClient,
	chatId: string,
	event: StreamEvent,
): Promise<void> {
	const parsed = Schema.decodeUnknownResult(chatUpdateEventSchema)(event);
	if (parsed._tag === "Failure") {
		return;
	}
	const update = parsed.success;
	if ("chatId" in update && update.chatId !== chatId) {
		return;
	}
	if (update.type === "chat.notice") {
		const notice = { id: uuidv4(), text: update.notice };
		queries.setQueryData<ChatNotice[]>(noticesKey(chatId), (notices = []) => [...notices, notice]);
		return;
	}
	if (update.type === "member.typing") {
		const { member } = update;
		queries.setQueryData<TypingMember[]>(typingKey(chatId), (typing = []) =>
			withMemberTyping(typing, member),
		);
		return;
	}
	if (update.type === "message.created") {
		// A new message moves the chat on, past what its notices were about.
		queries.setQueryData<ChatNotice[]>(noticesKey(chatId), []);
		// And whoever wrote it has stopped typing it.
		const { author } = update.message;
		if (author.kind === "member") {
			queries.setQueryData<TypingMember[]>(typingKey(chatId), (typing) =>
				typing?.filter((entry) => entry.member.id !== author.id),
			);
		}
	}
	if (update.type === "message.reactions_changed") {
		changeReactions(queries, { id: update.messageId, chatId }, update.reactions);
		return;
	}
	await queries.cancelQueries({ queryKey: ["chat", chatId] });
	if (!queries.getQueryData(["chat", chatId])) {
		await queries.invalidateQueries({ queryKey: ["chat", chatId] });
		return;
	}
	if (
		update.type === "reset" ||
		// A turn starting takes up the messages that waited for it.
		update.type === "turn.started" ||
		update.type === "turn.completed" ||
		update.type === "chat.changed"
	) {
		await Promise.all([
			queries.invalidateQueries({ queryKey: ["chat", chatId] }),
			queries.invalidateQueries({ queryKey: ["chat-context", chatId] }),
		]);
		return;
	}
	if (update.type === "message.created") {
		queries.setQueryData<ChatDetails>(["chat", chatId], (details) =>
			details ? upsertChatMessage(details, update.message) : details,
		);
		return;
	}
	if (update.type === "chat.read") {
		const { member, readThrough, readAt } = update;
		queries.setQueryData<ChatDetails>(["chat", chatId], (details) =>
			details ? wichat(details, { member, readThrough, readAt }) : details,
		);
		return;
	}

	let messageId: string;
	let applyMessage: (message: Message) => Message;
	if (update.type === "message.delta") {
		messageId = update.messageId;
		const current = queries
			.getQueryData<ChatDetails>(["chat", chatId])
			?.messages.find((message) => message.id === messageId);
		if (current && update.offset > current.content.length) {
			// Text was missed, so appending would garble the message. The row is
			// flushed as it streams; fetching it catches up.
			await queries.invalidateQueries({ queryKey: ["chat", chatId] });
			return;
		}
		const { offset, text } = update;
		// A delta already applied (a reconnect, a duplicate) is skipped, not appended twice.
		applyMessage = (message) =>
			offset < message.content.length ? message : withContent(message, `${message.content}${text}`);
	} else if (update.type === "message.completed") {
		messageId = update.messageId;
		const { content, status, finishedAt } = update;
		applyMessage = (message) => ({ ...withContent(message, content), status, finishedAt });
	} else if (
		update.type === "tool_call.started" ||
		update.type === "tool_call.completed" ||
		update.type === "tool_call.updated"
	) {
		messageId = update.messageId;
		const { toolCall } = update;
		applyMessage = (message) => withPlacedPart(message, toolCall);
		refreshFilesAfter(queries, toolCall);
	} else if (update.type === "message.files_changed") {
		messageId = update.messageId;
		const { files } = update;
		applyMessage = (message) => ({ ...message, parts: [...partsWithoutFiles(message), ...files] });
	} else if (update.type === "message.failed") {
		messageId = update.messageId;
		const { error } = update;
		applyMessage = (message) => ({ ...message, status: "failed", error });
	} else {
		return;
	}

	queries.setQueryData<ChatDetails>(["chat", chatId], (details) =>
		details ? updateChatMessage(details, messageId, applyMessage) : details,
	);
}

async function applyWorkspaceEvent(
	queries: QueryClient,
	workspaceId: string,
	event: StreamEvent,
): Promise<void> {
	const parsed = Schema.decodeUnknownResult(workspaceUpdateEventSchema)(event);
	if (parsed._tag === "Failure") {
		return;
	}
	const update = parsed.success;
	switch (update.type) {
		case "chat.nested_chat_changed":
			await Promise.all([
				queries.invalidateQueries({
					queryKey: ["chat-messages", update.rootChatId],
				}),
				queries.invalidateQueries({
					queryKey: ["chat-history", update.rootChatId],
				}),
				// Only a run being accepted or settled changes what an automation's feed shows beside it.
				refreshAutomations(queries),
				// A new message moves its chat up the list, changes its preview, and may leave it unread.
				refreshAfterChatChange(queries, workspaceId),
			]);
			return;
		case "chat.changed":
			await Promise.all([
				queries.invalidateQueries({ queryKey: ["chat-history"] }),
				// A message, a reply, or an approval asked for may change how a chat stands in the lists.
				refreshAfterChatChange(queries, workspaceId),
			]);
			return;
		case "reset":
			// Any number of the events above may have been missed, so everything they keep fresh is fetched again.
			await Promise.all([
				queries.invalidateQueries({ queryKey: ["chat-messages"] }),
				queries.invalidateQueries({ queryKey: ["chat-history"] }),
				refreshAutomations(queries),
				refreshAfterChatChange(queries, workspaceId),
			]);
			return;
		default:
			update satisfies never;
	}
}

function updateChatMessage(
	details: ChatDetails,
	messageId: string,
	update: (message: Message) => Message,
): ChatDetails {
	return {
		...details,
		messages: details.messages.map((message) =>
			message.id === messageId ? update(message) : message,
		),
	};
}

/** The message with new text, keeping every tool call where it was made. */
function withContent(message: Message, content: string): Message {
	return { ...message, content, parts: rebuiltParts(message, content, placedParts(message)) };
}

/**
 * The message with one tool call added or brought up to date. An update keeps
 * the call's place: calls made at the same offset stay in the order they were
 * made.
 */
function withPlacedPart(message: Message, part: PlacedPart): Message {
	const placed = placedParts(message);
	const updated = placed.some((made) => made.id === part.id)
		? placed.map((made) => (made.id === part.id ? part : made))
		: [...placed, part];
	return { ...message, parts: rebuiltParts(message, message.content, updated) };
}

/**
 * The parts drawn afresh from the text and what was placed in it, with what
 * is attached to the message after them, which is never placed in its text.
 */
function rebuiltParts(message: Message, content: string, placed: PlacedPart[]): MessagePart[] {
	return [...messagePartsFor(content, placed), ...message.parts.filter(isAttached)];
}

function partsWithoutFiles(message: Message): MessagePart[] {
	return message.parts.filter((part) => part.type !== "file");
}

/** `details` with `read` in place of what it had of the same member, unless it had them further on. */
function wichat(details: ChatDetails, read: ChatRead): ChatDetails {
	const previous = details.reads.find(({ member }) => member.id === read.member.id);
	if (previous && Date.parse(previous.readThrough) >= Date.parse(read.readThrough)) return details;
	return {
		...details,
		reads: [...details.reads.filter(({ member }) => member.id !== read.member.id), read],
	};
}

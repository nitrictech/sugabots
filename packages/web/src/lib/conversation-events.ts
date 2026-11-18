import {
	type ConversationDetails,
	type ConversationRead,
	conversationUpdateEventSchema,
	isAttached,
	type Message,
	type MessagePart,
	messagePartsFor,
	type PersonParticipant,
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
import { refreshAfterConversationChange, refreshChatMarkers } from "@/lib/chats.ts";
import { refreshFilesAfter } from "@/lib/files.ts";
import { changeReactions } from "@/lib/reactions.ts";
import { useWorkspace } from "@/lib/workspace.ts";

export function useConversationEvents(conversationId: string | undefined): void {
	const queries = useQueryClient();

	useEffect(() => {
		if (!conversationId) return;
		const stream = client.events.conversation(conversationId);
		void consume(stream, (event) => applyConversationEvent(queries, conversationId, event)).catch(
			() => {
				void queries.invalidateQueries({ queryKey: ["conversation", conversationId] });
			},
		);
		return () => stream.close();
	}, [queries, conversationId]);
}

/** Something the conversation's events told its watchers that no message records. */
export interface ConversationNotice {
	id: string;
	text: string;
}

/**
 * What the conversation's events have said since its last new message that no
 * message records, oldest first: why a reply somebody asked for is not
 * coming. Kept only while the conversation is watched, since the server keeps
 * notices in no conversation's history.
 */
export function useConversationNotices(
	conversationId: string | undefined,
): readonly ConversationNotice[] {
	return (
		useQuery({
			queryKey: noticesKey(conversationId ?? ""),
			queryFn: (): ConversationNotice[] => [],
			enabled: conversationId !== undefined,
			staleTime: Number.POSITIVE_INFINITY,
		}).data ?? []
	);
}

const noticesKey = (conversationId: string) => ["conversation-notices", conversationId] as const;

/** How often a person still typing says so again. */
const TYPING_SIGNAL_INTERVAL_MS = 3_000;

/**
 * How long a person is shown typing after they last said so. Long enough for
 * the next signal to arrive late without them flickering out.
 */
const TYPING_SHOWN_FOR_MS = 2 * TYPING_SIGNAL_INTERVAL_MS;

/** A person the conversation's events said is typing, and until when they are shown. */
interface TypingPerson {
	person: PersonParticipant;
	/** Epoch milliseconds. */
	shownUntil: number;
}

const typingKey = (conversationId: string) => ["conversation-typing", conversationId] as const;

/**
 * Tells the conversation's other watchers the user is typing when `draft` changes
 * to text, at most once per `TYPING_SIGNAL_INTERVAL_MS`. A draft kept from an
 * earlier visit is not typing until it is edited. An emptied draft, as after
 * sending, lets the next keystroke say so straight away.
 */
export function useTypingSignal(conversationId: string | undefined, draft: string): void {
	const lastSentAt = useRef(0);
	const previousDraft = useRef(draft);

	useEffect(() => {
		const edited = draft !== previousDraft.current;
		previousDraft.current = draft;
		if (!conversationId || !edited) return;
		if (!draft.trim()) {
			lastSentAt.current = 0;
			return;
		}
		const now = Date.now();
		if (now - lastSentAt.current < TYPING_SIGNAL_INTERVAL_MS) return;
		lastSentAt.current = now;
		// Best effort: a lost signal only means the dots show a moment late.
		void Effect.runPromise(client.api.events.typing({ params: { conversationId } })).catch(
			() => {},
		);
	}, [conversationId, draft]);
}

/**
 * The people typing in the conversation, other than `userId`, in the order they
 * started. Each drops out once their signals stop or their message arrives.
 */
export function usePeopleTyping(
	conversationId: string | undefined,
	userId: string,
): readonly PersonParticipant[] {
	const typing =
		useQuery({
			queryKey: typingKey(conversationId ?? ""),
			queryFn: (): TypingPerson[] => [],
			enabled: conversationId !== undefined,
			staleTime: Number.POSITIVE_INFINITY,
		}).data ?? [];
	const [now, setNow] = useState(Date.now);
	const shown = typing.filter(({ person, shownUntil }) => person.id !== userId && shownUntil > now);
	const nextExpiry = Math.min(...shown.map(({ shownUntil }) => shownUntil));

	useEffect(() => {
		if (!Number.isFinite(nextExpiry)) return;
		const timer = setTimeout(() => setNow(Date.now()), nextExpiry - Date.now());
		return () => clearTimeout(timer);
	}, [nextExpiry]);

	return shown.map(({ person }) => person);
}

/** `typing` with `person` shown for another `TYPING_SHOWN_FOR_MS`, and without anyone expired. */
function withPersonTyping(typing: TypingPerson[], person: PersonParticipant): TypingPerson[] {
	const now = Date.now();
	const shownUntil = now + TYPING_SHOWN_FOR_MS;
	const current = typing.filter((entry) => entry.shownUntil > now);
	return current.some((entry) => entry.person.id === person.id)
		? current.map((entry) => (entry.person.id === person.id ? { person, shownUntil } : entry))
		: [...current, { person, shownUntil }];
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
			void refreshChatMarkers(queries, workspaceId);
		});
		return () => stream.close();
	}, [queries, workspaceId]);
}

function upsertConversationMessage(
	details: ConversationDetails,
	incoming: Message,
): ConversationDetails {
	return {
		...details,
		messages: mergeConversationMessages(details.messages, [incoming]),
	};
}

export function mergeConversationMessages(current: Message[], incoming: Message[]): Message[] {
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

async function applyConversationEvent(
	queries: QueryClient,
	conversationId: string,
	event: StreamEvent,
): Promise<void> {
	const parsed = Schema.decodeUnknownResult(conversationUpdateEventSchema)(event);
	if (parsed._tag === "Failure") {
		return;
	}
	const update = parsed.success;
	if ("conversationId" in update && update.conversationId !== conversationId) {
		return;
	}
	if (update.type === "conversation.notice") {
		const notice = { id: uuidv4(), text: update.notice };
		queries.setQueryData<ConversationNotice[]>(noticesKey(conversationId), (notices = []) => [
			...notices,
			notice,
		]);
		return;
	}
	if (update.type === "person.typing") {
		const { person } = update;
		queries.setQueryData<TypingPerson[]>(typingKey(conversationId), (typing = []) =>
			withPersonTyping(typing, person),
		);
		return;
	}
	if (update.type === "message.created") {
		// A new message moves the conversation on, past what its notices were about.
		queries.setQueryData<ConversationNotice[]>(noticesKey(conversationId), []);
		// And whoever wrote it has stopped typing it.
		const { author } = update.message;
		if (author.kind === "person") {
			queries.setQueryData<TypingPerson[]>(typingKey(conversationId), (typing) =>
				typing?.filter((entry) => entry.person.id !== author.id),
			);
		}
	}
	if (update.type === "message.reactions_changed") {
		changeReactions(queries, { id: update.messageId, conversationId }, update.reactions);
		return;
	}
	await queries.cancelQueries({ queryKey: ["conversation", conversationId] });
	if (!queries.getQueryData(["conversation", conversationId])) {
		await queries.invalidateQueries({ queryKey: ["conversation", conversationId] });
		return;
	}
	if (
		update.type === "reset" ||
		// A turn starting takes up the messages that waited for it.
		update.type === "turn.started" ||
		update.type === "turn.completed" ||
		update.type === "conversation.changed"
	) {
		await Promise.all([
			queries.invalidateQueries({ queryKey: ["conversation", conversationId] }),
			queries.invalidateQueries({ queryKey: ["conversation-activity", conversationId] }),
		]);
		return;
	}
	if (update.type === "message.created") {
		queries.setQueryData<ConversationDetails>(["conversation", conversationId], (details) =>
			details ? upsertConversationMessage(details, update.message) : details,
		);
		return;
	}
	if (update.type === "conversation.read") {
		const { person, readThrough, readAt } = update;
		queries.setQueryData<ConversationDetails>(["conversation", conversationId], (details) =>
			details ? withRead(details, { person, readThrough, readAt }) : details,
		);
		return;
	}

	let messageId: string;
	let applyMessage: (message: Message) => Message;
	if (update.type === "message.delta") {
		messageId = update.messageId;
		const current = queries
			.getQueryData<ConversationDetails>(["conversation", conversationId])
			?.messages.find((message) => message.id === messageId);
		if (current && update.offset > current.content.length) {
			// Text was missed, so appending would garble the message. The row is
			// flushed as it streams; fetching it catches up.
			await queries.invalidateQueries({ queryKey: ["conversation", conversationId] });
			return;
		}
		const { offset, text } = update;
		// A delta already applied (a reconnect, a duplicate) is skipped, not appended twice.
		applyMessage = (message) =>
			offset < message.content.length ? message : withContent(message, `${message.content}${text}`);
	} else if (update.type === "message.completed") {
		messageId = update.messageId;
		const { content, status } = update;
		// The event does not say when the turn ended; it ended as it arrived, near enough.
		const finishedAt = new Date().toISOString();
		applyMessage = (message) => ({
			...withContent(message, content),
			status,
			finishedAt: message.finishedAt ?? finishedAt,
		});
	} else if (update.type === "collaboration.updated") {
		messageId = update.messageId;
		const { collaboration } = update;
		applyMessage = (message) => withPlacedPart(message, collaboration);
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

	queries.setQueryData<ConversationDetails>(["conversation", conversationId], (details) =>
		details ? updateConversationMessage(details, messageId, applyMessage) : details,
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
		case "conversation.item_changed":
			await Promise.all([
				queries.invalidateQueries({ queryKey: ["chat-messages", update.rootConversationId] }),
				queries.invalidateQueries({ queryKey: ["chat-history", update.rootConversationId] }),
				// A new message moves its conversation up the list, changes its preview, and may leave it unread.
				refreshAfterConversationChange(queries, workspaceId),
			]);
			return;
		case "conversation.changed":
			await Promise.all([
				queries.invalidateQueries({ queryKey: ["chat-history"] }),
				// A message, a reply, or an approval asked for may change how a chat stands in the lists.
				refreshAfterConversationChange(queries, workspaceId),
			]);
			return;
		case "reset":
			// Any number of the events above may have been missed, so everything they keep fresh is fetched again.
			await Promise.all([
				queries.invalidateQueries({ queryKey: ["chat-messages"] }),
				queries.invalidateQueries({ queryKey: ["chat-history"] }),
				refreshAfterConversationChange(queries, workspaceId),
			]);
			return;
		default:
			update satisfies never;
	}
}

function updateConversationMessage(
	details: ConversationDetails,
	messageId: string,
	update: (message: Message) => Message,
): ConversationDetails {
	return {
		...details,
		messages: details.messages.map((message) =>
			message.id === messageId ? update(message) : message,
		),
	};
}

/** The message with new text, keeping every collaboration and tool call where it was made. */
function withContent(message: Message, content: string): Message {
	return { ...message, content, parts: rebuiltParts(message, content, placedParts(message)) };
}

/**
 * The message with one collaboration or tool call added or brought up to date.
 * An update keeps the part's place: parts made at the same offset, like
 * parallel collaborations, stay in the order they were made.
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

/** `details` with `read` in place of what it had of the same person, unless it had them further on. */
function withRead(details: ConversationDetails, read: ConversationRead): ConversationDetails {
	const previous = details.reads.find(({ person }) => person.id === read.person.id);
	if (previous && Date.parse(previous.readThrough) >= Date.parse(read.readThrough)) return details;
	return {
		...details,
		reads: [...details.reads.filter(({ person }) => person.id !== read.person.id), read],
	};
}

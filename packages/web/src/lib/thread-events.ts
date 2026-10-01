import {
	type Message,
	type MessagePart,
	messagePartsFor,
	type PersonParticipant,
	type PlacedPart,
	placedParts,
	type StreamEvent,
	type ThreadDetails,
	threadUpdateEventSchema,
	workspaceUpdateEventSchema,
} from "@sugabots/contracts";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect, Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { client } from "@/api.ts";
import { refreshChatMarkers } from "@/lib/chats.ts";
import { useWorkspace } from "@/lib/workspace.ts";

export function useThreadEvents(threadId: string | undefined): void {
	const queries = useQueryClient();

	useEffect(() => {
		if (!threadId) return;
		const stream = client.events.thread(threadId);
		void consume(stream, (event) => applyThreadEvent(queries, threadId, event)).catch(() => {
			void queries.invalidateQueries({ queryKey: ["thread", threadId] });
		});
		return () => stream.close();
	}, [queries, threadId]);
}

/** Something the thread's events told its watchers that no message records. */
export interface ThreadNotice {
	id: string;
	text: string;
}

/**
 * What the thread's events have said since its last new message that no
 * message records, oldest first: why a reply somebody asked for is not
 * coming. Kept only while the thread is watched, since the server keeps
 * notices in no thread's history.
 */
export function useThreadNotices(threadId: string | undefined): readonly ThreadNotice[] {
	return (
		useQuery({
			queryKey: noticesKey(threadId ?? ""),
			queryFn: (): ThreadNotice[] => [],
			enabled: threadId !== undefined,
			staleTime: Number.POSITIVE_INFINITY,
		}).data ?? []
	);
}

const noticesKey = (threadId: string) => ["thread-notices", threadId] as const;

/** How often a person still typing says so again. */
const TYPING_SIGNAL_INTERVAL_MS = 3_000;

/**
 * How long a person is shown typing after they last said so. Long enough for
 * the next signal to arrive late without them flickering out.
 */
const TYPING_SHOWN_FOR_MS = 2 * TYPING_SIGNAL_INTERVAL_MS;

/** A person the thread's events said is typing, and until when they are shown. */
interface TypingPerson {
	person: PersonParticipant;
	/** Epoch milliseconds. */
	shownUntil: number;
}

const typingKey = (threadId: string) => ["thread-typing", threadId] as const;

/**
 * Tells the thread's other watchers the user is typing when `draft` changes
 * to text, at most once per `TYPING_SIGNAL_INTERVAL_MS`. A draft kept from an
 * earlier visit is not typing until it is edited. An emptied draft, as after
 * sending, lets the next keystroke say so straight away.
 */
export function useTypingSignal(threadId: string | undefined, draft: string): void {
	const lastSentAt = useRef(0);
	const previousDraft = useRef(draft);

	useEffect(() => {
		const edited = draft !== previousDraft.current;
		previousDraft.current = draft;
		if (!threadId || !edited) return;
		if (!draft.trim()) {
			lastSentAt.current = 0;
			return;
		}
		const now = Date.now();
		if (now - lastSentAt.current < TYPING_SIGNAL_INTERVAL_MS) return;
		lastSentAt.current = now;
		// Best effort: a lost signal only means the dots show a moment late.
		void Effect.runPromise(client.api.events.typing({ params: { threadId } })).catch(() => {});
	}, [threadId, draft]);
}

/**
 * The people typing in the thread, other than `userId`, in the order they
 * started. Each drops out once their signals stop or their message arrives.
 */
export function usePeopleTyping(
	threadId: string | undefined,
	userId: string,
): readonly PersonParticipant[] {
	const typing =
		useQuery({
			queryKey: typingKey(threadId ?? ""),
			queryFn: (): TypingPerson[] => [],
			enabled: threadId !== undefined,
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
		// A stream that drops may have missed a new message, so the list is fetched afresh.
		void consume(stream, (event) => applyWorkspaceEvent(queries, workspaceId, event)).catch(() => {
			void queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] });
		});
		return () => stream.close();
	}, [queries, workspaceId]);
}

function upsertThreadMessage(details: ThreadDetails, incoming: Message): ThreadDetails {
	return {
		...details,
		messages: mergeThreadMessages(details.messages, [incoming]),
	};
}

export function mergeThreadMessages(current: Message[], incoming: Message[]): Message[] {
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

async function applyThreadEvent(
	queries: QueryClient,
	threadId: string,
	event: StreamEvent,
): Promise<void> {
	const parsed = Schema.decodeUnknownResult(threadUpdateEventSchema)(event);
	if (parsed._tag === "Failure") {
		return;
	}
	const update = parsed.success;
	if ("threadId" in update && update.threadId !== threadId) {
		return;
	}
	if (update.type === "thread.notice") {
		const notice = { id: crypto.randomUUID(), text: update.notice };
		queries.setQueryData<ThreadNotice[]>(noticesKey(threadId), (notices = []) => [
			...notices,
			notice,
		]);
		return;
	}
	if (update.type === "person.typing") {
		const { person } = update;
		queries.setQueryData<TypingPerson[]>(typingKey(threadId), (typing = []) =>
			withPersonTyping(typing, person),
		);
		return;
	}
	if (update.type === "message.created") {
		// A new message moves the thread on, past what its notices were about.
		queries.setQueryData<ThreadNotice[]>(noticesKey(threadId), []);
		// And whoever wrote it has stopped typing it.
		const { author } = update.message;
		if (author.kind === "person") {
			queries.setQueryData<TypingPerson[]>(typingKey(threadId), (typing) =>
				typing?.filter((entry) => entry.person.id !== author.id),
			);
		}
	}
	await queries.cancelQueries({ queryKey: ["thread", threadId] });
	if (!queries.getQueryData(["thread", threadId])) {
		await queries.invalidateQueries({ queryKey: ["thread", threadId] });
		return;
	}
	if (
		update.type === "reset" ||
		update.type === "turn.completed" ||
		update.type === "thread.changed"
	) {
		await Promise.all([
			queries.invalidateQueries({ queryKey: ["thread", threadId] }),
			queries.invalidateQueries({ queryKey: ["thread-activity", threadId] }),
		]);
		return;
	}
	if (update.type === "message.created") {
		queries.setQueryData<ThreadDetails>(["thread", threadId], (details) =>
			details ? upsertThreadMessage(details, update.message) : details,
		);
		return;
	}

	let messageId: string;
	let applyMessage: (message: Message) => Message;
	if (update.type === "message.delta") {
		messageId = update.messageId;
		const current = queries
			.getQueryData<ThreadDetails>(["thread", threadId])
			?.messages.find((message) => message.id === messageId);
		if (current && update.offset > current.content.length) {
			// Text was missed, so appending would garble the message. The row is
			// flushed as it streams; fetching it catches up.
			await queries.invalidateQueries({ queryKey: ["thread", threadId] });
			return;
		}
		const { offset, text } = update;
		// A delta already applied (a reconnect, a duplicate) is skipped, not appended twice.
		applyMessage = (message) =>
			offset < message.content.length ? message : withContent(message, `${message.content}${text}`);
	} else if (update.type === "message.completed") {
		messageId = update.messageId;
		const { content, status } = update;
		applyMessage = (message) => ({ ...withContent(message, content), status });
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
	} else if (update.type === "message.failed") {
		messageId = update.messageId;
		const { error } = update;
		applyMessage = (message) => ({ ...message, status: "failed", error });
	} else {
		return;
	}

	queries.setQueryData<ThreadDetails>(["thread", threadId], (details) =>
		details ? updateThreadMessage(details, messageId, applyMessage) : details,
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
	if (update.type === "chat.thread_changed") {
		await Promise.all([
			queries.invalidateQueries({ queryKey: ["chat-messages", update.chatId] }),
			queries.invalidateQueries({ queryKey: ["chat-history", update.chatId] }),
			// A new message moves its chat up the list, changes its preview, and may leave it unread.
			refreshChatMarkers(queries, workspaceId),
		]);
	} else if (update.type === "thread.changed") {
		await Promise.all([
			queries.invalidateQueries({ queryKey: ["chat-history"] }),
			// A message, a reply, or an approval asked for may change how a chat stands in the lists.
			refreshChatMarkers(queries, workspaceId),
		]);
	}
}

function updateThreadMessage(
	details: ThreadDetails,
	messageId: string,
	update: (message: Message) => Message,
): ThreadDetails {
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

/** The parts drawn afresh from the text and what was placed in it. */
function rebuiltParts(_message: Message, content: string, placed: PlacedPart[]): MessagePart[] {
	return messagePartsFor(content, placed);
}

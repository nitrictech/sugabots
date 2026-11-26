import {
	type ChatDetails,
	type ChatRead,
	chatUpdateEventSchema,
	DEFAULT_CHAT_HISTORY_LIMIT,
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
import { isApiFailure } from "@sugabots/sdk";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect, Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { client } from "@/api.ts";
import { refreshAutomations } from "@/lib/automations.ts";
import { refreshAfterChatChange, removeRepliesGoneFromTimeline } from "@/lib/chats.ts";
import { refreshFilesAfter } from "@/lib/files.ts";
import { changeReactions } from "@/lib/reactions.ts";
import { useSession } from "@/lib/session.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/**
 * Keeps the chat `chatId` current from its stream while it is on screen.
 *
 * Events are applied one at a time, in order: while one waits, such as for
 * the chat fetched afresh on `ready` or `reset`, the ones after it wait too.
 * A stream the server ends for good says why: a signed-out member's session
 * is asked about again, and a chat the member no longer reaches is dropped
 * from screen while what decides where they reach is fetched again.
 */
export function useChatEvents(chatId: string | undefined): void {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const { refresh: refreshSession } = useSession();

	useEffect(() => {
		if (!chatId) return;
		const stream = client.events.chat(chatId);
		const waiting: WaitingDeltas = new Map();
		void consume(stream, (event) => applyChatEvent(queries, chatId, event, waiting)).catch(
			(refusal) => {
				if (isSignedOut(refusal)) return void refreshSession().catch(() => {});
				if (isUnreached(refusal)) return void dropUnreachedChat(queries, chatId, workspaceId);
				void queries.invalidateQueries({ queryKey: ["chat", chatId] });
			},
		);
		return () => stream.close();
	}, [queries, chatId, workspaceId, refreshSession]);
}

/** Whether a stream ended because its session did. */
function isSignedOut(refusal: unknown): boolean {
	return isApiFailure(refusal) && refusal._tag === "Unauthorized";
}

/** Whether a stream ended because its member no longer reaches what it follows. */
function isUnreached(refusal: unknown): boolean {
	return isApiFailure(refusal) && (refusal._tag === "NotFound" || refusal._tag === "Forbidden");
}

/**
 * Drops what is shown of a chat the member no longer reaches, so it is not
 * left on screen as it was, and fetches again what decides where they reach.
 */
function dropUnreachedChat(queries: QueryClient, chatId: string, workspaceId: string | undefined) {
	return Promise.all([
		queries.resetQueries({ queryKey: ["chat", chatId], exact: true }),
		queries.resetQueries({ queryKey: ["chat-messages", chatId] }),
		...(workspaceId ? [refreshAfterReachChange(queries, workspaceId)] : []),
	]);
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
export const TYPING_SHOWN_FOR_MS = 2 * TYPING_SIGNAL_INTERVAL_MS;

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
		void Effect.runPromise(client.api.events.reportTyping({ params: { chatId } })).catch(() => {});
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
	const { refresh: refreshSession } = useSession();

	useEffect(() => {
		if (!workspaceId) {
			return;
		}
		const stream = client.events.workspace(workspaceId);
		// A stream the server ended for good may have missed anything, and may
		// mean the member left the workspace, so all it keeps fresh is fetched
		// again; a signed-out member's session is asked about again.
		void consume(stream, (event) => applyWorkspaceEvent(queries, workspaceId, event)).catch(
			(refusal) => {
				if (isSignedOut(refusal)) return void refreshSession().catch(() => {});
				void refreshAfterReachChange(queries, workspaceId);
			},
		);
		return () => stream.close();
	}, [queries, workspaceId, refreshSession]);
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
	waiting: WaitingDeltas,
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
	if (update.type === "ready" || update.type === "reset") {
		// What was fetched before may be behind the stream, or the stream missed
		// events: the chat as fetched now replaces it, its pages are fetched
		// again, and the events after this one wait until they have.
		await Promise.all([
			replaceChat(queries, chatId),
			queries.invalidateQueries({ queryKey: ["chat-context", chatId] }),
			queries.invalidateQueries({ queryKey: ["chat-messages", chatId] }),
		]);
		addWaitingDeltas(queries, chatId, waiting);
		return;
	}
	await queries.cancelQueries({ queryKey: ["chat", chatId] });
	if (!queries.getQueryData(["chat", chatId])) {
		await queries.invalidateQueries({ queryKey: ["chat", chatId] });
		return;
	}
	if (
		// A turn starting takes up the messages that waited for it.
		update.type === "turn.started" ||
		update.type === "turn.completed" ||
		update.type === "chat.changed"
	) {
		const fetchedBefore = queries.getQueryState(["chat", chatId])?.dataUpdatedAt ?? 0;
		await Promise.all([
			queries.invalidateQueries({ queryKey: ["chat", chatId] }),
			queries.invalidateQueries({ queryKey: ["chat-context", chatId] }),
		]);
		const fetched = queries.getQueryState<ChatDetails>(["chat", chatId]);
		// Only a chat fetched just now says which replies are gone: what was
		// cached before may not yet hold a reply another turn has started.
		const fetchedNow = fetched?.data !== undefined && fetched.dataUpdatedAt > fetchedBefore;
		if (update.type === "turn.completed" && fetched?.data && fetchedNow) {
			const latest = fetched.data;
			// A turn that stayed silent removed its reply, which the timeline's
			// pages may still show being written.
			removeRepliesGoneFromTimeline(queries, chatId, latest.messages);
			// A reply absent from the chat as fetched once a turn ended was
			// removed, as a silent turn removes its own; nothing more will add to it.
			for (const messageId of waiting.keys()) {
				if (!latest.messages.some(({ id }) => id === messageId)) waiting.delete(messageId);
			}
		}
		addWaitingDeltas(queries, chatId, waiting);
		return;
	}
	if (update.type === "message.created") {
		// The chat may have been fetched since the message was made, as
		// `turn.started` before its reply's creation has it fetched; what was
		// fetched is newer than what was created.
		queries.setQueryData<ChatDetails>(["chat", chatId], (details) =>
			details && !details.messages.some(({ id }) => id === update.message.id)
				? upsertChatMessage(details, update.message)
				: details,
		);
		addWaitingDeltas(queries, chatId, waiting);
		return;
	}
	if (update.type === "chat.read") {
		const { member, readThrough, readAt } = update;
		queries.setQueryData<ChatDetails>(["chat", chatId], (details) =>
			details ? advanceMemberReadCursor(details, { member, readThrough, readAt }) : details,
		);
		return;
	}

	let messageId: string;
	let applyMessage: (message: Message) => Message;
	if (update.type === "message.delta" || update.type === "message.thinking_delta") {
		const current = cachedMessage(queries, chatId, update.messageId);
		if (!current) {
			// Its reply's creation is still on its way, as a step's first thinking
			// can overtake it: kept until the reply arrives.
			keepWaiting(waiting, update);
			return;
		}
		const added = withDelta(current, update);
		if (added === "stale") return;
		if (added === "unplaced") {
			// Kept until the text it adds to is here, which is fetched now: its
			// execution's start, or the text before it, has not arrived yet.
			keepWaiting(waiting, update);
			await queries.invalidateQueries({ queryKey: ["chat", chatId] });
			addWaitingDeltas(queries, chatId, waiting);
			return;
		}
		setMessage(queries, chatId, added);
		addWaitingDeltas(queries, chatId, waiting);
		return;
	}
	if (update.type === "message.execution_started") {
		messageId = update.messageId;
		const { execution, content, thinking } = update;
		// What a newer execution restarts from replaces what an older one wrote,
		// or how it ended, as a turn that runs again reopens its reply; the reply
		// as fetched since it started already begins there.
		applyMessage = (message) => {
			if (message.execution !== undefined && execution <= message.execution) return message;
			const { error: _error, finishedAt: _finishedAt, ...reopened } = message;
			return { ...withContent(reopened, content), status: "writing", thinking, execution };
		};
	} else if (update.type === "message.completed") {
		messageId = update.messageId;
		const { content, status, finishedAt, execution } = update;
		applyMessage = (message) =>
			endedBefore(message, execution)
				? message
				: {
						...withContent(message, content),
						status,
						finishedAt,
						...(execution === undefined ? {} : { execution }),
					};
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
		const { error, execution } = update;
		applyMessage = (message) =>
			endedBefore(message, execution)
				? message
				: {
						...message,
						status: "failed",
						error,
						...(execution === undefined ? {} : { execution }),
					};
	} else {
		return;
	}

	queries.setQueryData<ChatDetails>(["chat", chatId], (details) =>
		details ? updateChatMessage(details, messageId, applyMessage) : details,
	);
	if (update.type === "message.execution_started") addWaitingDeltas(queries, chatId, waiting);
}

/**
 * Whether an end by `execution` is an older execution's than the one the
 * reply is as of, such as a failure that arrived after the turn ran again,
 * which says nothing of the reply now.
 */
function endedBefore(message: Message, execution: number | undefined): boolean {
	return (
		execution !== undefined && message.execution !== undefined && execution < message.execution
	);
}

type ChatUpdate = typeof chatUpdateEventSchema.Type;

/** Text or thinking a reply's turn wrote, as the chat's stream sends it while it writes. */
type ReplyDelta = Extract<ChatUpdate, { type: "message.delta" | "message.thinking_delta" }>;

/**
 * The deltas a chat's stream sent before the text they add to was there, by
 * reply, until it is: a delta of a newer execution can overtake its start,
 * and one can arrive before the text it follows has been fetched.
 */
type WaitingDeltas = Map<string, ReplyDelta[]>;

/** The most deltas kept waiting for one reply; past it, the oldest go. */
const MAX_WAITING_DELTAS = 500;

function keepWaiting(waiting: WaitingDeltas, delta: ReplyDelta): void {
	const kept = [...(waiting.get(delta.messageId) ?? []), delta];
	waiting.set(delta.messageId, kept.slice(-MAX_WAITING_DELTAS));
}

/**
 * Adds each waiting delta whose text is now there, by execution and offset,
 * for as long as one more can be added, and drops each one that never will.
 */
function addWaitingDeltas(queries: QueryClient, chatId: string, waiting: WaitingDeltas): void {
	for (const [messageId, deltas] of waiting) {
		const ordered = [...deltas].sort(
			(left, right) => left.execution - right.execution || left.offset - right.offset,
		);
		let still = ordered;
		let added = true;
		while (added && still.length > 0) {
			added = false;
			const next: ReplyDelta[] = [];
			for (const delta of still) {
				const current = cachedMessage(queries, chatId, messageId);
				const result = current && withDelta(current, delta);
				if (result === undefined || result === "unplaced") {
					next.push(delta);
				} else if (result !== "stale") {
					setMessage(queries, chatId, result);
					added = true;
				}
			}
			still = next;
		}
		if (still.length === 0) waiting.delete(messageId);
		else waiting.set(messageId, still);
	}
}

/**
 * The reply with `delta` added to the text its own execution wrote; `stale`
 * for one it never will be, from an older execution, into a reply its own
 * execution ended, or already there; `unplaced` while the text it adds to is
 * not there: its newer execution's start, or the text before its offset.
 */
function withDelta(current: Message, delta: ReplyDelta): Message | "stale" | "unplaced" {
	const { execution, offset, text } = delta;
	const baseline = current.execution;
	if (baseline !== undefined && execution < baseline) return "stale";
	if (baseline === execution && current.status !== "writing") return "stale";
	if (current.status !== "writing" || (baseline ?? execution) !== execution) return "unplaced";
	const step = delta.type === "message.thinking_delta" ? delta.step : undefined;
	const currentText =
		step === undefined
			? current.content
			: (current.thinking?.find((part) => part.step === step)?.text ?? "");
	const overlap = currentText.slice(offset);
	if (overlap.startsWith(text)) return "stale";
	if (offset > currentText.length || !text.startsWith(overlap)) return "unplaced";
	const combined = currentText.slice(0, offset) + text;
	if (step === undefined) return { ...withContent(current, combined), execution };
	return {
		...current,
		execution,
		thinking: [
			...(current.thinking ?? []).filter((part) => part.step !== step),
			{ step, text: combined },
		].sort((left, right) => left.step - right.step),
	};
}

function cachedMessage(queries: QueryClient, chatId: string, messageId: string) {
	return queries
		.getQueryData<ChatDetails>(["chat", chatId])
		?.messages.find((message) => message.id === messageId);
}

function setMessage(queries: QueryClient, chatId: string, message: Message): void {
	queries.setQueryData<ChatDetails>(["chat", chatId], (details) =>
		details ? updateChatMessage(details, message.id, () => message) : details,
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
				// Only a run being accepted or settled changes what an automation's feed shows beside it.
				refreshAutomations(queries),
				// A new message moves its chat up the list, changes its preview, and may leave it unread.
				refreshAfterChatChange(queries, workspaceId),
			]);
			return;
		case "chat.changed":
			// A message, a reply, or an approval asked for may change how a chat stands in the lists.
			await refreshAfterChatChange(queries, workspaceId);
			return;
		case "reach.changed":
			await refreshAfterReachChange(queries, workspaceId);
			return;
		case "member.changed":
			// A member's name, and so their handle, shows wherever they do.
			await queries.invalidateQueries();
			return;
		case "ready":
		case "reset":
			// What the lists were fetched before may be behind the stream, or any
			// number of the events above were missed, so everything they keep fresh
			// is fetched again.
			await Promise.all([
				queries.invalidateQueries({ queryKey: ["chat-messages"] }),
				refreshAutomations(queries),
				refreshAfterReachChange(queries, workspaceId),
			]);
			return;
		default:
			update satisfies never;
	}
}

/**
 * Fetches again what a change of who reaches what may have changed: who
 * reaches a project, bot or the workspace, or what someone's role lets them
 * do there, changes what the lists show, what the member may do in the
 * workspace, and whose turns each member may interrupt in a chat. A stream
 * that lost what it follows ends on its own.
 */
function refreshAfterReachChange(queries: QueryClient, workspaceId: string) {
	return Promise.all([
		queries.invalidateQueries({ queryKey: ["chat"] }),
		queries.invalidateQueries({ queryKey: ["projects"] }),
		queries.invalidateQueries({ queryKey: ["project-members"] }),
		queries.invalidateQueries({ queryKey: ["project-bots"] }),
		queries.invalidateQueries({ queryKey: ["bots"] }),
		queries.invalidateQueries({ queryKey: ["workspaces"] }),
		queries.invalidateQueries({ queryKey: ["workspace-standing"] }),
		refreshAfterChatChange(queries, workspaceId),
	]);
}

/**
 * Replaces what the cache holds of the chat with the chat as fetched now,
 * merging nothing kept from before, which may be text an execution since
 * superseded. A refusal to show the chat ends its stream as the server's own
 * would; any other failure leaves the chat to be fetched as usual.
 */
async function replaceChat(queries: QueryClient, chatId: string): Promise<void> {
	await queries.cancelQueries({ queryKey: ["chat", chatId], exact: true });
	try {
		const latest = await Effect.runPromise(
			client.api.chats.get({ params: { chatId }, query: { limit: DEFAULT_CHAT_HISTORY_LIMIT } }),
		);
		queries.setQueryData<ChatDetails>(["chat", chatId], (current) =>
			withEarlierPagesKept(current, latest),
		);
	} catch (failure) {
		if (isSignedOut(failure) || isUnreached(failure)) throw failure;
		await queries.invalidateQueries({ queryKey: ["chat", chatId] });
	}
}

/**
 * `latest`, the chat's newest page as fetched now, after the earlier messages
 * `current` had loaded before it, such as a run's older pages, with the cursor
 * to what comes before them. Only where the two meet: with messages between
 * them unloaded, `latest` alone, which the member loads back from.
 */
function withEarlierPagesKept(current: ChatDetails | undefined, latest: ChatDetails): ChatDetails {
	const [oldestLatest] = latest.messages;
	if (!current || !oldestLatest || latest.olderMessagesCursor === null) return latest;
	if (!current.messages.some(({ id }) => id === oldestLatest.id)) return latest;
	const earlier = current.messages.filter((message) => comesBefore(message, oldestLatest));
	if (earlier.length === 0) return latest;
	return {
		...latest,
		messages: [...earlier, ...latest.messages],
		olderMessagesCursor: current.olderMessagesCursor,
	};
}

/** Whether `message` comes before `other` in the chat, as `mergeChatMessages` orders them. */
function comesBefore(message: Message, other: Message): boolean {
	return message.createdAt === other.createdAt
		? message.id < other.id
		: message.createdAt < other.createdAt;
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
function advanceMemberReadCursor(details: ChatDetails, read: ChatRead): ChatDetails {
	const previous = details.reads.find(({ member }) => member.id === read.member.id);
	if (previous && Date.parse(previous.readThrough) >= Date.parse(read.readThrough)) return details;
	return {
		...details,
		reads: [...details.reads.filter(({ member }) => member.id !== read.member.id), read],
	};
}

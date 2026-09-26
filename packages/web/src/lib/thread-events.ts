import {
	type Message,
	type MessagePart,
	messagePartsFor,
	type PlacedPart,
	placedParts,
	type StreamEvent,
	type ThreadDetails,
	threadUpdateEventSchema,
	workspaceUpdateEventSchema,
} from "@sugabots/contracts";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect } from "react";
import { client } from "@/api.ts";
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
		await queries.invalidateQueries({ queryKey: ["thread", threadId] });
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
			// A new message moves its chat up the list and changes its preview.
			queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
		]);
	} else if (update.type === "thread.changed") {
		await queries.invalidateQueries({ queryKey: ["chat-history"] });
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

/** The message with one collaboration or tool call added or brought up to date. */
function withPlacedPart(message: Message, part: PlacedPart): Message {
	const others = placedParts(message).filter((made) => made.id !== part.id);
	return { ...message, parts: rebuiltParts(message, message.content, [...others, part]) };
}

/** The parts drawn afresh from the text and what was placed in it. */
function rebuiltParts(_message: Message, content: string, placed: PlacedPart[]): MessagePart[] {
	return messagePartsFor(content, placed);
}

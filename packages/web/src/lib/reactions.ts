import type {
	ChatMessagesPage,
	Message,
	MessageReaction,
	SessionUser,
	ThreadDetails,
} from "@sugabots/contracts";
import {
	type InfiniteData,
	type QueryClient,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/** One person's emoji on a message, and whether they are adding it or taking it back. */
interface ReactionChange {
	message: Message;
	emoji: string;
	reacting: boolean;
}

/**
 * Adds or takes back the user's reactions, showing each at once. They are sent
 * one at a time, in the order they were made. An answer, or a refusal putting
 * back what the message had, is only taken while nothing newer has changed
 * the message: another of the user's reactions, or the thread's event saying
 * what the message has.
 */
export function useReactions(user: SessionUser) {
	const queries = useQueryClient();
	const mutation = useMutation({
		scope: { id: "reactions" },
		mutationFn: ({ message, emoji, reacting }: ReactionChange) => {
			const request = { params: { messageId: message.id, emoji } };
			return Effect.runPromise(
				reacting ? client.api.threads.react(request) : client.api.threads.unreact(request),
			);
		},
		onMutate: ({ message, emoji, reacting }) => {
			const before = message.reactions ?? [];
			const person = { id: user.id, name: user.name, at: new Date().toISOString() };
			const change = changeReactions(
				queries,
				message,
				reacting ? withReaction(before, emoji, person) : withoutReaction(before, emoji, user.id),
			);
			return { before, change };
		},
		onSuccess: (reactions, { message }, context) => {
			if (isLatestChange(message.id, context.change))
				setMessageReactions(queries, message, reactions);
		},
		onError: (_error, { message }, context) => {
			if (context && isLatestChange(message.id, context.change)) {
				setMessageReactions(queries, message, context.before);
			}
		},
	});
	return {
		/** Adds the user's `emoji` to the message, or takes it back if they had it. */
		toggle: (message: Message, emoji: string) =>
			mutation.mutate({ message, emoji, reacting: !hasReacted(message, emoji, user.id) }),
		/** Adds the user's `emoji` to the message, unless they have it already. */
		add: (message: Message, emoji: string) => {
			if (!hasReacted(message, emoji, user.id)) mutation.mutate({ message, emoji, reacting: true });
		},
	};
}

/**
 * How many times each message's reactions have been changed by the user or an
 * event since the page loaded, so an answer can tell whether it is still the
 * newest word on them. Answers themselves do not count.
 */
const changesByMessage = new Map<string, number>();

/**
 * Puts `reactions` on the message as its newest change, which an answer to an
 * earlier request will not then undo, returning which change it is. The
 * thread's events put in what the message has through this.
 */
export function changeReactions(
	queries: QueryClient,
	message: Pick<Message, "id" | "threadId">,
	reactions: MessageReaction[],
): number {
	const change = (changesByMessage.get(message.id) ?? 0) + 1;
	changesByMessage.set(message.id, change);
	setMessageReactions(queries, message, reactions);
	return change;
}

function isLatestChange(messageId: string, change: number): boolean {
	return changesByMessage.get(messageId) === change;
}

/** Whether the person is among those who reacted to the message with `emoji`. */
export function hasReacted(message: Message, emoji: string, userId: string): boolean {
	return (
		message.reactions?.some(
			(reaction) =>
				reaction.emoji === emoji && reaction.people.some((person) => person.id === userId),
		) ?? false
	);
}

/**
 * Puts `reactions` on the message wherever the cache holds it: its thread, and
 * the chat pages it was loaded in, which an older message may only be in.
 */
function setMessageReactions(
	queries: QueryClient,
	message: Pick<Message, "id" | "threadId">,
	reactions: MessageReaction[],
): void {
	const withReactions = (current: Message): Message => {
		if (current.id !== message.id) return current;
		const { reactions: _previous, ...rest } = current;
		return reactions.length > 0 ? { ...rest, reactions } : rest;
	};
	queries.setQueryData<ThreadDetails>(["thread", message.threadId], (details) =>
		details ? { ...details, messages: details.messages.map(withReactions) } : details,
	);
	queries.setQueriesData<InfiniteData<ChatMessagesPage | undefined>>(
		{ queryKey: ["chat-messages"] },
		(data) =>
			data && {
				...data,
				pages: data.pages.map(
					(page) =>
						page && {
							...page,
							items: page.items.map((item) =>
								item.kind === "message" ? { ...item, message: withReactions(item.message) } : item,
							),
						},
				),
			},
	);
}

function withReaction(
	reactions: MessageReaction[],
	emoji: string,
	person: MessageReaction["people"][number],
): MessageReaction[] {
	if (!reactions.some((reaction) => reaction.emoji === emoji)) {
		return [...reactions, { emoji, people: [person] }];
	}
	return reactions.map((reaction) =>
		reaction.emoji === emoji && !reaction.people.some(({ id }) => id === person.id)
			? { ...reaction, people: [...reaction.people, person] }
			: reaction,
	);
}

function withoutReaction(
	reactions: MessageReaction[],
	emoji: string,
	userId: string,
): MessageReaction[] {
	return reactions
		.map((reaction) =>
			reaction.emoji === emoji
				? { ...reaction, people: reaction.people.filter(({ id }) => id !== userId) }
				: reaction,
		)
		.filter((reaction) => reaction.people.length > 0);
}

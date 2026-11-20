import type {
	ChatMessagesPage,
	ConversationDetails,
	Message,
	MessageReaction,
	SessionUser,
} from "@sugabots/contracts";
import {
	type InfiniteData,
	type QueryClient,
	type QueryKey,
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
 * one at a time, in the order they were made. Whether a click adds or takes
 * back is read from the user's last click still being sent, else from the
 * message, so two clicks before the first shows still add and take back. An
 * answer, or a refusal putting back what the message had and asking the server
 * again, is only taken while nothing newer has changed the message: another of
 * the user's reactions, or the conversation's event saying what the message has.
 */
export function useReactions(user: SessionUser) {
	const queries = useQueryClient();
	const mutation = useMutation({
		mutationKey: REACTION_MUTATION_KEY,
		scope: { id: "reactions" },
		mutationFn: ({ message, emoji, reacting }: ReactionChange) => {
			const request = { params: { messageId: message.id, emoji } };
			return Effect.runPromise(
				reacting
					? client.api.conversations.react(request)
					: client.api.conversations.unreact(request),
			);
		},
		onMutate: async ({ message, emoji, reacting }) => {
			// A load already under way answers with the message as it was, which would put back
			// what this changes; it is called off here and made again once this is settled.
			const interrupted = await cancelMessageLoads(queries, message);
			const before = message.reactions ?? [];
			const person = { id: user.id, name: user.name, at: new Date().toISOString() };
			const change = changeReactions(
				queries,
				message,
				reacting ? withReaction(before, emoji, person) : withoutReaction(before, emoji, user.id),
			);
			return { before, change, interrupted };
		},
		onSuccess: (reactions, { message }, context) => {
			if (isLatestChange(message.id, context.change))
				setMessageReactions(queries, message, reactions);
		},
		onError: (_error, { message }, context) => {
			if (!context || !isLatestChange(message.id, context.change)) return;
			// `before` is the message as drawn when clicked, which misses the user's earlier
			// clicks still being sent then, so the server is asked what the message has.
			setMessageReactions(queries, message, context.before);
			for (const queryKey of messageLoadKeys(message)) {
				void queries.invalidateQueries({ queryKey });
			}
		},
		onSettled: (_result, _error, _change, context) => {
			for (const queryKey of context?.interrupted ?? []) {
				void queries.invalidateQueries({ queryKey });
			}
		},
	});
	/** Whether the user has `emoji` on the message, counting what they have asked for and is still being sent. */
	const reacted = (message: Message, emoji: string) =>
		lastSentChange(queries, message, emoji)?.reacting ?? hasReacted(message, emoji, user.id);
	return {
		/** Adds the user's `emoji` to the message, or takes it back if they had it. */
		toggle: (message: Message, emoji: string) =>
			mutation.mutate({ message, emoji, reacting: !reacted(message, emoji) }),
		/** Adds the user's `emoji` to the message, unless they have it already. */
		add: (message: Message, emoji: string) => {
			if (!reacted(message, emoji)) mutation.mutate({ message, emoji, reacting: true });
		},
	};
}

/** Marks the user's reaction requests in the mutation cache, for `lastSentChange` to find. */
const REACTION_MUTATION_KEY = ["reaction"];

/**
 * The user's last change to `emoji` on the message that is still being sent,
 * if any. Read from the mutation cache, which holds a request from its click,
 * even while it waits behind earlier ones, rather than from the message, which
 * shows a click only once its change is applied, after the click that follows
 * may already have read it.
 */
function lastSentChange(
	queries: QueryClient,
	message: Message,
	emoji: string,
): ReactionChange | undefined {
	const pending = queries.getMutationCache().findAll({
		mutationKey: REACTION_MUTATION_KEY,
		status: "pending",
		predicate: ({ state }) => {
			const change = state.variables as ReactionChange | undefined;
			return change?.message.id === message.id && change.emoji === emoji;
		},
	});
	return pending.at(-1)?.state.variables as ReactionChange | undefined;
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
 * conversation's events put in what the message has through this.
 */
export function changeReactions(
	queries: QueryClient,
	message: Pick<Message, "id" | "conversationId">,
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
function hasReacted(message: Message, emoji: string, userId: string): boolean {
	return (
		message.reactions?.some(
			(reaction) =>
				reaction.emoji === emoji && reaction.people.some((person) => person.id === userId),
		) ?? false
	);
}

/**
 * Calls off loads of the message's conversation and its pages that are under
 * way, returning the keys of those it called off.
 */
async function cancelMessageLoads(
	queries: QueryClient,
	message: Pick<Message, "conversationId">,
): Promise<QueryKey[]> {
	const loading = messageLoadKeys(message).filter(
		(queryKey) => queries.isFetching({ queryKey }) > 0,
	);
	await Promise.all(loading.map((queryKey) => queries.cancelQueries({ queryKey })));
	return loading;
}

/** The queries that load the message's conversation and its pages. */
function messageLoadKeys(message: Pick<Message, "conversationId">): QueryKey[] {
	return [
		["conversation", message.conversationId],
		["conversation-messages", message.conversationId],
	];
}

/**
 * Puts `reactions` on the message wherever the cache holds it: its conversation, and
 * the chat pages it was loaded in, which an older message may only be in.
 */
function setMessageReactions(
	queries: QueryClient,
	message: Pick<Message, "id" | "conversationId">,
	reactions: MessageReaction[],
): void {
	const withReactions = (current: Message): Message => {
		if (current.id !== message.id) return current;
		const { reactions: _previous, ...rest } = current;
		return reactions.length > 0 ? { ...rest, reactions } : rest;
	};
	queries.setQueryData<ConversationDetails>(["conversation", message.conversationId], (details) =>
		details ? { ...details, messages: details.messages.map(withReactions) } : details,
	);
	queries.setQueriesData<InfiniteData<ChatMessagesPage | undefined>>(
		{ queryKey: ["conversation-messages"] },
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
		.filter((reaction) => reaction.people.length > 0 || (reaction.bots?.length ?? 0) > 0);
}

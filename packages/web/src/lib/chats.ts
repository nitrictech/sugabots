import {
	type AutomationUpdate,
	type Bot,
	type Channel,
	type ChatMessageItem,
	type ConversationDetails,
	type FilePart,
	handleFromName,
	type InboxItem,
	type MessageReplyTo,
	type NewMessage,
	type NewTask,
	type PersonParticipant,
	type SessionUser,
	type StartedTask,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import {
	infiniteQueryOptions,
	type QueryClient,
	queryOptions,
	skipToken,
	useInfiniteQuery,
	useIsMutating,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { useEffect, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { client } from "@/api.ts";
import { useAutomationActions } from "@/lib/automations.ts";
import { useBots } from "@/lib/bots.ts";
import { findChannel, useChannels } from "@/lib/channels.ts";
import { conversationQuery } from "@/lib/conversations.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { countOf, listNames } from "@/lib/name-list.ts";
import { useWorkspace } from "@/lib/workspace.ts";

const PAGE_SIZE = 30;
const RUNNING_CHAT_HISTORY_REFETCH_INTERVAL_MS = 1_000;

/**
 * A channel's conversations, by the channel's slug: what a chat page's
 * address names, so a page can ask for it before it knows the channel's id.
 */
function chatListQuery(workspaceId: string | undefined, channelSlug: string | undefined) {
	return queryOptions({
		queryKey: ["chat-list", workspaceId, channelSlug],
		queryFn:
			workspaceId && channelSlug
				? ({ signal }) =>
						Effect.runPromise(
							client.api.chats.list({
								params: { workspace: workspaceId },
								query: { channel: channelSlug },
							}),
							{ signal },
						)
				: skipToken,
	});
}

/** A channel's conversations, by its slug: its main chat, then its threads in the order they were started. */
export function useChatList(channelSlug: string | undefined) {
	return useQuery(chatListQuery(useWorkspace().workspace?.id, channelSlug));
}

/** A bot's tasks, most recent message first, and its automations. */
function botTasksQuery(workspaceId: string | undefined, botId: string | undefined) {
	return queryOptions({
		queryKey: ["bot-tasks", workspaceId, botId],
		queryFn:
			workspaceId && botId
				? ({ signal }) =>
						Effect.runPromise(client.api.chats.botTasks({ params: { botId } }), { signal })
				: skipToken,
	});
}

/** The tasks and automations of the bot `botId`; nothing is asked while it is undefined. */
export function useBotTasks(botId: string | undefined) {
	return useQuery(botTasksQuery(useWorkspace().workspace?.id, botId));
}

/**
 * How each channel and bot stands for the sidebar: its unread messages,
 * whether any conversation waits on the person, and a bot's failed automations.
 */
export function useChannelConversationMarkers() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["chat-channel-markers", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.chats.channelMarkers({ params: { workspace: workspaceId } }),
						{
							signal,
						},
					)
			: skipToken,
	});
}

const inboxFeedKey = (workspaceId: string | undefined) => ["inbox", workspaceId];
const APPROVAL_INBOX = "chat-approvals";
const approvalInboxKey = (workspaceId: string | undefined) => [APPROVAL_INBOX, workspaceId];

/**
 * What is new for the person across the workspace's chats: messages that
 * mention them or they have not read, automation runs, and collaborations.
 */
export function useInboxFeed() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: inboxFeedKey(workspaceId),
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.chats.inbox({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

/**
 * The approvals across the workspace: those waiting on the person, and the
 * latest answered.
 */
export function useApprovalInbox() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: approvalInboxKey(workspaceId),
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.chats.approvals({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

const directMessagesKey = (workspaceId: string | undefined) => ["direct-messages", workspaceId];

/** The person's direct messages with other people, the most recent first. */
export function useDirectMessages() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: directMessagesKey(workspaceId),
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.chats.directMessages({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
}

/**
 * Sends a message to `userIds`, in the direct message between the person and
 * them, which the API opens when they have none. Resolves once the lists that
 * show it know of it, with the direct message it went to.
 */
export function useSendDirectMessage() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: ({ userIds, message }: { userIds: readonly string[]; message: string }) => {
			if (!workspaceId) throw new NotReadyError();
			return Effect.runPromise(
				client.api.chats.sendDirectMessage({
					params: { workspace: workspaceId },
					payload: { userIds: [...userIds], id: uuidv4(), message },
				}),
			);
		},
		onSuccess: ({ conversation }) =>
			Promise.all([
				queries.invalidateQueries({ queryKey: directMessagesKey(workspaceId) }),
				queries.invalidateQueries({ queryKey: directMessageKey(conversation.id) }),
				queries.invalidateQueries({ queryKey: ["chat-messages", conversation.id] }),
				queries.invalidateQueries({ queryKey: ["conversation", conversation.id] }),
			]),
	});
}

/** What a direct message with somebody who has left the workspace goes by. */
const FORMER_MEMBER = "Former member";

/** The others in a direct message between people: those still here, by name, and how many have left. */
export interface DirectPeople {
	people: readonly PersonParticipant[];
	formerMembers: number;
}

/** How many have left, as words: "1 former member". */
function formerMembersOf(count: number): string {
	return countOf(count, "former member", "former members");
}

/** A person, as a message's author or somebody it is written to. */
export function personParticipantOf(person: {
	id: string;
	name: string;
	email: string;
	image?: string | null;
}): PersonParticipant {
	return {
		kind: "person",
		id: person.id,
		name: person.name,
		email: person.email,
		handle: handleFromName(person.name),
		image: person.image ?? null,
	};
}

/** Whether a direct message is with one other person, rather than a group; who has left counts as one. */
export function isOneToOne({ people, formerMembers }: DirectPeople): boolean {
	return people.length + formerMembers <= 1;
}

/**
 * The others in a direct message as its title says them: "Juno, Theo and
 * Sam", then any who have left, "and 1 former member". One person who has
 * left is a Former member.
 */
export function directPeopleTitle({ people, formerMembers }: DirectPeople): string {
	if (people.length === 0)
		return formerMembers <= 1 ? FORMER_MEMBER : formerMembersOf(formerMembers);
	const names = people.map((person) => person.name);
	if (formerMembers === 0) return listNames(names);
	return `${names.join(", ")} and ${formerMembersOf(formerMembers)}`;
}

/** The others in a direct message as a list's row names them, shortest first: "Juno, Theo". */
export function directPeopleRowName(direct: DirectPeople): string {
	if (direct.people.length === 0) return directPeopleTitle(direct);
	return directPeopleNames(direct).join(", ");
}

/** The others in a direct message, by name, then those who have left as how many: "1 former member". */
export function directPeopleNames({ people, formerMembers }: DirectPeople): string[] {
	return [
		...people.map((person) => person.name),
		...(formerMembers > 0 ? [formerMembersOf(formerMembers)] : []),
	];
}

const directMessageKey = (conversationId: string) => ["direct-message", conversationId];

/**
 * The direct message `conversationId`, and who is in it, once loaded:
 * `found` is `undefined` when it is not one of the person's in the workspace
 * open, as one from another of their workspaces is not shown in this one's
 * place, and `error` set only when it could not be loaded at all.
 */
export function useDirectMessage(conversationId: string): {
	found: DirectPlace | undefined;
	isPending: boolean;
	error: unknown;
} {
	const workspace = useWorkspace();
	// The list is fetched afresh as the workspace's events come and the window
	// regains focus, so once it has the conversation, who is in it comes from
	// there. Until the list is loaded the conversation is asked for alongside
	// it, so the page does not wait on both in turn; once loaded, only one it
	// does not have is.
	const listed = useDirectMessages().data?.items.find(
		(candidate) => candidate.conversation.id === conversationId,
	);
	const item = useQuery({
		queryKey: directMessageKey(conversationId),
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.chats.directMessage({ params: { conversationId } }), {
				signal,
			}),
		enabled: !listed,
	});
	const missing = isApiFailure(item.error) && item.error._tag === "NotFound";
	const loaded = listed ?? item.data;
	const shown = loaded?.conversation.workspaceId === workspace.workspace?.id ? loaded : undefined;
	// Kept while the conversation's people stay the same, so its screen is not
	// handed a new one at every render.
	const people = shown?.people;
	const formerMembers = shown?.formerMembers;
	const found = useMemo((): DirectPlace | undefined => {
		if (!people || formerMembers === undefined) return undefined;
		return { channel: null, conversation: { kind: "directMessage", people, formerMembers } };
	}, [people, formerMembers]);
	return {
		found,
		isPending: (!listed && item.isPending) || workspace.isPending,
		error: missing ? undefined : item.error,
	};
}

/** How much in the workspace is waiting for the person. */
export type AttentionCounts = {
	/**
	 * Messages written to the person that they have not read: those and
	 * automation results that mention them, and every message in their direct
	 * messages.
	 */
	unreadForYou: number;
	/** Everything in Inbox the person has not read: mentions, messages, runs and collaborations. */
	unreadInInbox: number;
	/** Approvals waiting on the person. */
	waitingApprovals: number;
};

/**
 * How much in the workspace is waiting for the person, which the sidebar and the
 * app's badge count. Mentions, and what else is unread, come from the
 * inbox, so they are counted among its latest items only; what is
 * unread in direct messages comes from their list, which counts all of it.
 */
export function useAttentionCounts(): AttentionCounts {
	const { data: approvals } = useApprovalInbox();
	const { data: inbox } = useInboxFeed();
	const { data: directMessages } = useDirectMessages();
	// A mention in a direct message is counted with the direct message's unread messages.
	const directIds = new Set(directMessages?.items.map((item) => item.conversation.id));
	const mentionsElsewhere =
		inbox?.items.filter(
			(item) => item.unread && !directIds.has(item.rootConversationId) && mentionsYou(item),
		).length ?? 0;
	const unreadInDirectMessages =
		directMessages?.items.reduce((sum, item) => sum + item.unreadMessages, 0) ?? 0;
	return {
		unreadForYou: mentionsElsewhere + unreadInDirectMessages,
		unreadInInbox: inbox?.items.filter((item) => item.unread).length ?? 0,
		waitingApprovals: approvals?.waiting.length ?? 0,
	};
}

/** Whether an Inbox item names the person: a mention, or an automation run whose result asks for them. */
function mentionsYou(item: InboxItem): boolean {
	return item.kind === "mention" || (item.kind === "run" && item.mentionsYou);
}

/**
 * Records that the person has read the conversation up to its newest message, and
 * clears its dot and its count in the sidebar.
 */
export function useMarkChatRead(conversationId: string | undefined) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: () =>
			conversationId
				? Effect.runPromise(client.api.chats.markRead({ params: { conversationId } }))
				: Promise.resolve(),
		onSuccess: () => refreshChatMarkers(queries, workspaceId),
	});
}

/**
 * Records that the person has read each of `conversationIds` up to its newest
 * message, as Inbox's Mark all as read does, and clears what marks them.
 */
export function useMarkChatsRead() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (conversationIds: readonly string[]) =>
			Effect.runPromise(
				Effect.forEach(
					conversationIds,
					(conversationId) => client.api.chats.markRead({ params: { conversationId } }),
					{ concurrency: MARK_READ_CONCURRENCY, discard: true },
				),
			),
		onSettled: () => refreshChatMarkers(queries, workspaceId),
	});
}

/**
 * Marks one automation run or collaboration read, by its own conversation, while the
 * window has focus, without reading the rest of the conversation it is in.
 * Checks when the item opens and when the window gains focus.
 */
export function useMarkItemReadWhileSeen(itemConversationId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const { mutate } = useMutation({
		mutationFn: (conversationId: string) =>
			Effect.runPromise(client.api.chats.markItemRead({ params: { conversationId } })),
		onSuccess: () => refreshChatMarkers(queries, workspaceId),
	});
	useEffect(() => {
		const markIfFocused = () => {
			if (document.hasFocus()) mutate(itemConversationId);
		};
		markIfFocused();
		window.addEventListener("focus", markIfFocused);
		return () => window.removeEventListener("focus", markIfFocused);
	}, [itemConversationId, mutate]);
}

/** How many conversations Mark all as read marks at once. */
const MARK_READ_CONCURRENCY = 4;

/**
 * Marks the chat read while the person can see `newest`, its latest item: the
 * window has focus and `latestInView` holds. Checks when the chat opens, when
 * `newest` arrives or finishes, when `latestInView` turns true, and when the
 * window gains focus.
 *
 * Focus, not visibility: a window beside the one being worked in is visible,
 * and what arrives there is unseen until the person comes back to it.
 */
export function useMarkReadWhileSeen(
	conversationId: string | undefined,
	newest: ChatMessageItem | undefined,
	latestInView: boolean,
) {
	const { mutate } = useMarkChatRead(conversationId);
	const newestRevision = newest && readRevision(newest);
	useEffect(() => {
		if (!conversationId || newestRevision === undefined || !latestInView) return;
		const markIfFocused = () => {
			if (document.hasFocus()) mutate();
		};
		markIfFocused();
		window.addEventListener("focus", markIfFocused);
		return () => window.removeEventListener("focus", markIfFocused);
	}, [conversationId, newestRevision, latestInView, mutate]);
}

/**
 * What marking a chat read waits on in `item`: a message's id and status, so
 * a reply streaming in marks it once when it arrives and once when it
 * finishes, not at every word.
 */
function readRevision(item: ChatMessageItem): string {
	if (item.kind === "message") return `${item.message.id}:${item.message.status}`;
	// A run seen while it runs is read again once it ends.
	return item.kind === "run" ? `${item.id}:${item.state}` : item.id;
}

/** Fetches again what shows which chats are unread: the lists, the sidebar and the inbox. */
export function refreshChatMarkers(queries: QueryClient, workspaceId: string | undefined) {
	return Promise.all([
		queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
		queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId] }),
		queries.invalidateQueries({ queryKey: ["chat-channel-markers", workspaceId] }),
		queries.invalidateQueries({ queryKey: inboxFeedKey(workspaceId) }),
		queries.invalidateQueries({ queryKey: directMessagesKey(workspaceId) }),
	]);
}

/**
 * Fetches every workspace's approvals inbox again, for a request answered
 * where its workspace is not known.
 */
export function refreshEveryApprovalInbox(queries: QueryClient) {
	return queries.invalidateQueries({ queryKey: [APPROVAL_INBOX] });
}

/**
 * Fetches again everything a change in one of the workspace's conversations can
 * move: the chats' unread markers and the inbox, and the approvals inbox.
 */
export function refreshAfterConversationChange(
	queries: QueryClient,
	workspaceId: string | undefined,
) {
	return Promise.all([
		refreshChatMarkers(queries, workspaceId),
		queries.invalidateQueries({ queryKey: approvalInboxKey(workspaceId) }),
	]);
}

/**
 * Which kind of conversation is open, and the bot it is with when it has one:
 * a channel's main chat or thread, one of a bot's tasks or automations, or a
 * direct message between people, one other or a group, with no bot.
 */
export type ConversationPlaceKind =
	| { kind: "channelConversation" }
	| { kind: "botConversation"; bot: Bot }
	| ({ kind: "directMessage" } & DirectPeople);

/** A conversation in a channel. */
export interface ChannelPlace {
	channel: Channel;
	conversation: { kind: "channelConversation" };
}

/** One of a bot's tasks or automations, which is in no channel. */
export interface BotPlace {
	channel: null;
	conversation: { kind: "botConversation"; bot: Bot };
}

/** A conversation with bots in it: in a channel, or a bot's own. */
export type ConversationPlace = ChannelPlace | BotPlace;

/** A direct message between people, which is in no channel, and who is in it. */
export interface DirectPlace {
	channel: null;
	conversation: Extract<ConversationPlaceKind, { kind: "directMessage" }>;
}

/** The bot a place's conversation is with, if any. */
export function placeBot(place: { conversation: ConversationPlaceKind }): Bot | undefined {
	return place.conversation.kind === "botConversation" ? place.conversation.bot : undefined;
}

/**
 * Where the conversation `conversationId` is, in the channel at `channelSlug`;
 * `undefined` when there is none or it is not one in that channel. Read from
 * the channel's list, and from the conversation itself only when the list
 * does not have it, as an archived thread.
 */
export function useChannelConversationPlace(
	channelSlug: string,
	conversationId: string | undefined,
): { found: ChannelPlace | undefined; isPending: boolean; error: unknown } {
	const channels = useChannels();
	const list = useChatList(channelSlug);
	const listed = list.data?.chats.some((chat) => chat.conversation.id === conversationId) ?? false;
	const unlisted = useQuery({
		...conversationQuery(conversationId),
		enabled: conversationId !== undefined && list.isSuccess && !listed,
	});
	const channel = findChannel(channels.data, channelSlug);
	const inChannel =
		listed ||
		(unlisted.data?.conversation?.kind === "channel_conversation" &&
			unlisted.data.conversation.channelId === channel?.id);
	return {
		found:
			channel && inChannel ? { channel, conversation: { kind: "channelConversation" } } : undefined,
		isPending:
			channels.isPending || list.isPending || (list.isSuccess && !listed && unlisted.isPending),
		error: channels.error ?? list.error ?? unlisted.error,
	};
}

/**
 * Where the conversation `conversationId` is when it is one of the bot
 * `bot`'s: one of its tasks or automations; `undefined` when it is
 * not.
 */
export function useBotConversationPlace(
	bot: Bot,
	conversationId: string | undefined,
): { found: BotPlace | undefined; isPending: boolean; error: unknown } {
	const list = useBotTasks(bot.id);
	const listed =
		list.data?.tasks.some((item) => item.conversation.id === conversationId) ||
		list.data?.automations.some((item) => item.conversation?.id === conversationId) ||
		false;
	const unlisted = useQuery({
		...conversationQuery(conversationId),
		enabled: conversationId !== undefined && list.isSuccess && !listed,
	});
	const ours = listed || unlisted.data?.conversation?.botId === bot.id;
	return {
		found: ours ? { channel: null, conversation: { kind: "botConversation", bot } } : undefined,
		isPending: list.isPending || (list.isSuccess && !listed && unlisted.isPending),
		error: list.error ?? unlisted.error,
	};
}

/**
 * Where any conversation `conversationId` is, read from the conversation
 * itself: in a channel, a bot's, or a direct message. For a page, such as
 * Inbox's, whose address names only the conversation.
 */
export function useAnyConversationPlace(conversationId: string): {
	found: ConversationPlace | DirectPlace | undefined;
	isPending: boolean;
	error: unknown;
} {
	const channels = useChannels();
	const roster = useBots();
	const opened = useQuery(conversationQuery(conversationId));
	const details = opened.data?.conversation;
	const direct = useDirectMessage(conversationId);
	if (details?.kind === "direct_message") return direct;
	const channel = details?.channelId
		? channels.data?.find((one) => one.id === details.channelId)
		: undefined;
	const bot = details?.botId ? roster.bots?.find((one) => one.id === details.botId) : undefined;
	const found: ConversationPlace | undefined = channel
		? { channel, conversation: { kind: "channelConversation" } }
		: bot
			? { channel: null, conversation: { kind: "botConversation", bot } }
			: undefined;
	return {
		found,
		isPending: opened.isPending || channels.isPending || roster.isPending,
		error: opened.error ?? channels.error ?? roster.error,
	};
}

/**
 * The channel's main chat, read from its list when somebody has opened it,
 * and otherwise opened with a request.
 */
export function useOpenChannelConversation(channel: Channel) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["channel-conversation", workspaceId, channel.id],
		queryFn: workspaceId
			? async ({ signal }) => {
					const list = await queries.ensureQueryData(chatListQuery(workspaceId, channel.slug));
					return (
						list.chats.find((chat) => chat.conversation.main)?.conversation ??
						Effect.runPromise(
							client.api.chats.openMainChat({
								params: { workspace: workspaceId, channelId: channel.id },
							}),
							{ signal },
						)
					);
				}
			: skipToken,
	});
}

/**
 * The automation's feed, read from its bot's list when it has one, and
 * otherwise opened with a request.
 */
export function useOpenAutomationFeed(botId: string, automationId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["automation-feed", workspaceId, automationId],
		queryFn: workspaceId
			? async ({ signal }) => {
					const list = await queries.ensureQueryData(botTasksQuery(workspaceId, botId));
					return (
						list.automations.find((item) => item.automation.id === automationId)?.conversation ??
						Effect.runPromise(
							client.api.chats.openAutomationFeed({
								params: { workspace: workspaceId, automationId },
							}),
							{ signal },
						)
					);
				}
			: skipToken,
	});
}

/**
 * Starts loading the conversation an address names: as its page first loads,
 * and for a link the pointer is on, so it is on screen when the click lands.
 * A failure is left for the screen's own queries to meet and show.
 */
export function prefetchConversation(queries: QueryClient, conversationId: string): void {
	void queries.prefetchInfiniteQuery(chatMessagesQuery(conversationId));
	void queries.prefetchInfiniteQuery(chatHistoryQuery(conversationId));
	void queries.prefetchQuery(conversationQuery(conversationId));
}

/** The conversation, a page at a time, newest page first. */
function chatMessagesQuery(conversationId: string | undefined) {
	return infiniteQueryOptions({
		queryKey: ["chat-messages", conversationId],
		queryFn: conversationId
			? ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
					Effect.runPromise(
						client.api.chats.messages({
							params: { conversationId },
							query: { limit: PAGE_SIZE, cursor: pageParam },
						}),
						{ signal },
					)
			: skipToken,
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page?.nextCursor ?? undefined,
	});
}

/** The runs and collaborations opened beside the conversation, a page at a time, newest activity first. */
function chatHistoryQuery(conversationId: string | undefined) {
	return infiniteQueryOptions({
		queryKey: ["chat-history", conversationId],
		refetchInterval: (current) =>
			current.state.data?.pages.some((page) =>
				page?.items.some((entry) => entry.status === "queued" || entry.status === "running"),
			)
				? RUNNING_CHAT_HISTORY_REFETCH_INTERVAL_MS
				: false,
		queryFn: conversationId
			? ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
					Effect.runPromise(
						client.api.chats.history({
							params: { conversationId },
							query: { limit: PAGE_SIZE, cursor: pageParam },
						}),
						{ signal },
					)
			: skipToken,
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page?.nextCursor ?? undefined,
	});
}

export function useChatMessages(conversationId: string | undefined) {
	const query = useInfiniteQuery(chatMessagesQuery(conversationId));
	const items = query.data?.pages
		.slice()
		.reverse()
		.flatMap((page) => page?.items ?? []);
	return { ...query, items: items ?? [] };
}

export function useChatHistory(conversationId: string | undefined) {
	const query = useInfiniteQuery(chatHistoryQuery(conversationId));
	return {
		...query,
		entries: query.data?.pages.flatMap((page) => page?.items ?? []) ?? [],
	};
}

/**
 * A message to send, with the whole quote it answers and the files it
 * attaches, so it shows both before the API answers.
 */
export type MessageToSend = Omit<NewMessage, "replyTo" | "attachments"> & {
	replyTo?: MessageReplyTo;
	files?: readonly FilePart[];
};

export function useSendChatMessage(conversationId: string, user: SessionUser) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: async ({ replyTo, files = [], ...message }: MessageToSend) => {
			const payload: NewMessage = {
				...message,
				...(replyTo && { replyTo: replyTo.id }),
				...(files.length > 0 && { attachments: files.map((file) => file.id) }),
			};
			return Effect.runPromise(client.api.chats.send({ params: { conversationId }, payload }));
		},
		onMutate: async (input) => {
			await queries.cancelQueries({ queryKey: ["chat-messages", conversationId] });
			const optimistic: ChatMessageItem = {
				kind: "message",
				message: {
					id: input.id,
					conversationId,
					author: personParticipantOf(user),
					kind: "text",
					status: "complete",
					parts: [
						...(input.message === "" ? [] : [{ type: "text" as const, text: input.message }]),
						...(input.files ?? []),
					],
					content: input.message,
					...(input.replyTo ? { replyTo: input.replyTo } : {}),
					createdAt: timestampAfter(
						queries.getQueryData<ConversationDetails>(["conversation", conversationId])?.messages ??
							[],
					),
				},
			};
			queries.setQueryData(["chat-optimistic", conversationId], (items: ChatMessageItem[] = []) => [
				...items,
				optimistic,
			]);
		},
		onSettled: async (_result, _error, input) => {
			queries.setQueryData<ChatMessageItem[]>(["chat-optimistic", conversationId], (items) =>
				items?.filter((item) => item.kind !== "message" || item.message.id !== input.id),
			);
			await Promise.all([
				queries.invalidateQueries({ queryKey: ["chat-messages", conversationId] }),
				queries.invalidateQueries({ queryKey: ["chat-history", conversationId] }),
				queries.invalidateQueries({ queryKey: ["conversation", conversationId] }),
				queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
				queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId] }),
			]);
		},
	});
}

/** What the composer says when the API did not start a task. */
export const TASK_NOT_STARTED = "The task was not started. Your draft is still here.";

/**
 * How starting a task from a draft went: started; refused by the API; or not
 * sent, because the draft has no words to title it.
 */
export type TaskStart =
	| { outcome: "started"; task: StartedTask }
	| { outcome: "refused" }
	| { outcome: "notSent" };

/**
 * Starts tasks with the bot `botId`, each with a draft as its first message;
 * files are added once it has started. The bot's list shows each task once it
 * has.
 */
export function useTaskStarter(botId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const startTask = useMutation({
		mutationFn: (payload: NewTask) =>
			Effect.runPromise(client.api.chats.startTask({ params: { botId }, payload })),
		onSettled: () => queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId, botId] }),
	});
	async function start(draft: string): Promise<TaskStart> {
		const message = draft.trim();
		if (startTask.isPending || message === "") return { outcome: "notSent" };
		try {
			const task = await startTask.mutateAsync({ id: uuidv4(), message });
			return { outcome: "started", task };
		} catch {
			return { outcome: "refused" };
		}
	}
	return { start, isPending: startTask.isPending };
}

/**
 * Starts the task in which a bot its maker just made interviews them, when
 * the bot is due one; resolves to the task, or null.
 */
export function useStartInterview() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (botId: string) =>
			Effect.runPromise(client.api.chats.startInterview({ params: { botId } })),
		onSettled: (_task, _error, botId) =>
			queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId, botId] }),
	});
}

/** Marks the task done, or reopens it. The task and its bot's list show it once it has. */
export function useSetDone(conversationId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (done: boolean) =>
			Effect.runPromise(
				done
					? client.api.chats.markDone({ params: { conversationId } })
					: client.api.chats.reopen({ params: { conversationId } }),
			),
		onSettled: () =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["conversation", conversationId] }),
				queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId] }),
			]),
	});
}

/**
 * What an automation's feed does with its automation: run it again, which
 * turns on one that paused itself after failing, pause or resume it, and
 * rename it.
 * `pending` is shared by every control of the automation on screen, so none
 * starts another change while one is on its way. The feed, its page and
 * its bot's list are fetched again after each.
 */
export function useAutomationControls(
	/** Its feed, or undefined where it is controlled without one. */
	conversationId: string | undefined,
	automation: { id: string; botId: string },
) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const actions = useAutomationActions();
	const mutationKey = ["automation-controls", automation.id];
	const refresh = () =>
		Promise.all([
			conversationId && queries.invalidateQueries({ queryKey: ["conversation", conversationId] }),
			conversationId && queries.invalidateQueries({ queryKey: ["chat-messages", conversationId] }),
			queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId] }),
		]);
	const scope = { botId: automation.botId, automationId: automation.id };
	const runAgain = useMutation({
		mutationKey,
		mutationFn: () => actions.run.mutateAsync(scope),
		onSuccess: refresh,
	});
	const update = useMutation({
		mutationKey,
		mutationFn: (json: AutomationUpdate) => actions.update.mutateAsync({ ...scope, json }),
		onSuccess: refresh,
	});
	return {
		runAgain: () => runAgain.mutateAsync(),
		setPaused: (paused: boolean) => update.mutateAsync({ state: paused ? "paused" : "enabled" }),
		/** Renames the automation, and its feed with it. */
		rename: (name: string) => update.mutateAsync({ name }),
		pending: useIsMutating({ mutationKey }) > 0,
	};
}

/** Starts a thread in the channel, named `name`. The channel's list shows it once it has. */
export function useStartChat(channel: Channel) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (name: string) =>
			Effect.runPromise(
				client.api.chats.startChat({ params: { channelId: channel.id }, payload: { name } }),
			),
		onSettled: () => queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
	});
}

/** Renames the channel's thread `conversationId`. The channel's list and the thread show it once it has. */
export function useRenameChat(conversationId: string) {
	const refresh = useRefreshChat(conversationId);
	return useMutation({
		mutationFn: (name: string) =>
			Effect.runPromise(
				client.api.chats.renameChat({ params: { conversationId }, payload: { name } }),
			),
		onSettled: refresh,
	});
}

/** Archives the channel's thread `conversationId`, which takes it off the channel's list. */
export function useArchiveChat(conversationId: string) {
	const refresh = useRefreshChat(conversationId);
	return useMutation({
		mutationFn: () =>
			Effect.runPromise(client.api.chats.archiveChat({ params: { conversationId } })),
		onSettled: refresh,
	});
}

/** Fetches again what shows a channel's thread as it is: the thread, and the channel's list. */
function useRefreshChat(conversationId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return () =>
		Promise.all([
			queries.invalidateQueries({ queryKey: ["conversation", conversationId] }),
			queries.invalidateQueries({ queryKey: ["chat-list", workspaceId] }),
		]);
}

/**
 * A timestamp for a message being sent that sorts after every message shown:
 * now, or a millisecond after the newest one if this browser's clock is behind
 * the server's.
 */
function timestampAfter(messages: readonly { createdAt: string }[]): string {
	const times = [Date.now(), ...messages.map(({ createdAt }) => Date.parse(createdAt) + 1)];
	return new Date(Math.max(...times)).toISOString();
}

/** When a chat item happened, which puts items in order. */
export function chatItemCreatedAt(item: ChatMessageItem): string {
	return item.kind === "message" ? item.message.createdAt : item.createdAt;
}

export function useOptimisticChatItems(conversationId: string | undefined): ChatMessageItem[] {
	const query = useQuery<ChatMessageItem[]>({
		queryKey: ["chat-optimistic", conversationId],
		queryFn: skipToken,
		initialData: [],
	});
	return query.data ?? [];
}

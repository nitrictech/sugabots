import {
	type AttentionCounts,
	type AutomationUpdate,
	type Bot,
	type ChatMessageItem,
	type ConversationDetails,
	type FilePart,
	type FirstThreadMessage,
	handleFromName,
	type ListedThread,
	type MessageReplyTo,
	type NewMessage,
	type PersonParticipant,
	type Project,
	type ProjectMarker,
	type SessionUser,
	type StartedThread,
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
import { useEffect, useEffectEvent, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { client } from "@/api.ts";
import { pollWhileAutomationsRun, useAutomationActions } from "@/lib/automations.ts";
import { useBots } from "@/lib/bots.ts";
import { conversationQuery } from "@/lib/conversations.ts";
import { countOf, listNames } from "@/lib/name-list.ts";
import { findProject, useProjects } from "@/lib/projects.ts";
import { useRequiredWorkspaceId, useWorkspace } from "@/lib/workspace.ts";

const PAGE_SIZE = 30;
const RUNNING_CHAT_HISTORY_REFETCH_INTERVAL_MS = 1_000;

/*
 * The keys of the queries below. Each takes its scope from the widest part to
 * the narrowest, and a shorter key matches every query under it, so
 * `projectThreadsKey(workspaceId)` refreshes every project's list there.
 */

export const projectThreadsKey = (...scope: [workspaceId?: string, projectId?: string]) => [
	"project-threads",
	...scope,
];
/** Among the workspace's thread lists, so whatever refreshes those refreshes it. */
const recentThreadsKey = (workspaceId: string | undefined, limit: number) => [
	...projectThreadsKey(workspaceId),
	"recent",
	limit,
];
const attentionCountsKey = (...scope: [workspaceId?: string]) => ["attention-counts", ...scope];
const projectMarkersKey = (workspaceId: string | undefined) => ["project-markers", workspaceId];
const inboxFeedKey = (workspaceId: string | undefined) => ["inbox", workspaceId];
const approvalInboxKey = (...scope: [workspaceId?: string]) => ["approval-inbox", ...scope];
const directMessagesKey = (workspaceId: string | undefined) => ["direct-messages", workspaceId];
const directMessageKey = (conversationId: string) => ["direct-message", conversationId];
const conversationMessagesKey = (...scope: [conversationId?: string]) => [
	"conversation-messages",
	...scope,
];
const conversationHistoryKey = (...scope: [conversationId?: string]) => [
	"conversation-history",
	...scope,
];
const optimisticMessagesKey = (conversationId: string | undefined) => [
	"optimistic-messages",
	conversationId,
];
const automationFeedKey = (workspaceId: string | undefined, automationId: string) => [
	"automation-feed",
	workspaceId,
	automationId,
];

/**
 * A project's threads, the newest message first, and its automations, by the
 * project's id: a bot's are its default project's.
 */
function projectThreadsQuery(workspaceId: string | undefined, projectId: string | undefined) {
	return queryOptions({
		queryKey: projectThreadsKey(workspaceId, projectId),
		queryFn:
			workspaceId && projectId
				? ({ signal }) =>
						Effect.runPromise(client.api.chats.threads({ params: { projectId } }), { signal })
				: skipToken,
		refetchInterval: (query) => pollWhileAutomationsRun(query.state.data?.automations),
	});
}

/**
 * A project's threads not archived, the newest message first, and its
 * automations, by its id; a bot's by its default project's. Read again while
 * one of its automations runs. Nothing is asked while it is undefined.
 */
export function useProjectThreads(projectId: string | undefined) {
	return useQuery(projectThreadsQuery(useWorkspace().workspace?.id, projectId));
}

/** One of a bot's threads, with the bot. */
export type BotThread = ListedThread & { bot: Bot };

/**
 * The threads the person has been working on most lately, newest first: those
 * still open that they take part in, with the bots they pinned and their
 * Personal Assistant, whose threads the sidebar reads too.
 */
export function useRecentThreads(limit: number): BotThread[] {
	const workspaceId = useWorkspace().workspace?.id;
	const bots = useBots().bots;
	const recent = useQuery({
		queryKey: recentThreadsKey(workspaceId, limit),
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.chats.recentThreads({
							params: { workspace: workspaceId },
							query: { limit },
						}),
						{ signal },
					)
			: skipToken,
	});
	return (recent.data?.threads ?? []).flatMap((thread) => {
		const bot = bots?.find((one) => one.id === thread.conversation.botId);
		return bot ? [{ ...thread, bot }] : [];
	});
}

/** When a thread last had something in it: its newest message, else when it was started. */
export function lastMovedAt(row: ListedThread): number {
	return Date.parse(row.lastMessage?.at ?? row.conversation.createdAt);
}

/** How a project stands while the markers have nothing for it, or have not loaded. */
const NO_MARKER: ProjectMarker = {
	unreadMessages: 0,
	needsApproval: false,
	failedAutomations: 0,
};

/**
 * How each project stands for the sidebar, by its id: its unread messages,
 * whether any conversation waits on the person, and how many of its
 * automations are failing unseen. A bot's is its default project's.
 */
export function useProjectMarkers(): { markerOf: (projectId: string) => ProjectMarker } {
	const workspaceId = useWorkspace().workspace?.id;
	const { data } = useQuery({
		queryKey: projectMarkersKey(workspaceId),
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.chats.projectMarkers({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
	return { markerOf: (projectId) => data?.projects[projectId] ?? NO_MARKER };
}

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
	const requiredWorkspaceId = useRequiredWorkspaceId();
	return useMutation({
		mutationFn: ({ userIds, message }: { userIds: readonly string[]; message: string }) =>
			Effect.runPromise(
				client.api.chats.sendDirectMessage({
					params: { workspace: requiredWorkspaceId() },
					payload: { userIds: [...userIds], id: uuidv4(), message },
				}),
			),
		onSuccess: ({ conversation }) =>
			Promise.all([
				queries.invalidateQueries({ queryKey: directMessagesKey(workspaceId) }),
				queries.invalidateQueries({ queryKey: directMessageKey(conversation.id) }),
				queries.invalidateQueries({ queryKey: conversationMessagesKey(conversation.id) }),
				queries.invalidateQueries({ queryKey: conversationQuery(conversation.id).queryKey }),
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

/**
 * The direct message `conversationId`, and who is in it, once loaded:
 * `found` is `undefined` when it is not one of the person's in the workspace
 * open, as one from another of their workspaces is not shown in this one's
 * place, and `error` set only when it could not be loaded at all.
 */
export function useDirectMessage(
	conversationId: string,
	/** False while it isn't known to be a direct message, so nothing is asked for one that isn't. */
	enabled = true,
): {
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
		enabled: enabled && !listed,
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
		return { project: null, conversation: { kind: "directMessage", people, formerMembers } };
	}, [people, formerMembers]);
	return {
		found,
		isPending: (!listed && item.isPending) || workspace.isPending,
		error: missing ? undefined : item.error,
	};
}

/** How much waits for the person while the counts are loading: nothing. */
const NO_ATTENTION: AttentionCounts = {
	unreadInInbox: 0,
	waitingApprovals: 0,
	unreadForYou: 0,
};

/**
 * How much in the workspace is waiting for the person, which the sidebar and the
 * app's badge count, as the API counts it over the inbox's window.
 */
export function useAttentionCounts(): AttentionCounts {
	const workspaceId = useWorkspace().workspace?.id;
	const { data } = useQuery({
		queryKey: attentionCountsKey(workspaceId),
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.chats.attention({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
	return data ?? NO_ATTENTION;
}

/**
 * Records that the person has read the conversation up to its newest message, and
 * clears its dot and its count in the sidebar.
 */
function useMarkConversationRead(conversationId: string | undefined) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: () =>
			conversationId
				? Effect.runPromise(client.api.chats.markRead({ params: { conversationId } }))
				: Promise.resolve(),
		onSuccess: () => refreshConversationMarkers(queries, workspaceId),
	});
}

/**
 * Records that the person has read every conversation they reach in the
 * workspace, as Inbox's Mark all as read does, and clears what marks them.
 */
export function useMarkAllRead() {
	const queries = useQueryClient();
	const requireWorkspaceId = useRequiredWorkspaceId();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: () =>
			Effect.runPromise(
				client.api.chats.markAllRead({ params: { workspace: requireWorkspaceId() } }),
			),
		onSettled: () => refreshConversationMarkers(queries, workspaceId),
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
		onSuccess: () => refreshConversationMarkers(queries, workspaceId),
	});
	useWhileFocused(itemConversationId, () => mutate(itemConversationId));
}

/**
 * Marks the conversation read while the person can see `newest`, its latest item: the
 * window has focus and `latestInView` holds. Checks when it opens, when
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
	const { mutate } = useMarkConversationRead(conversationId);
	const seen =
		conversationId && newest && latestInView
			? `${conversationId}:${readRevision(newest)}`
			: undefined;
	useWhileFocused(seen, () => mutate());
}

/**
 * Calls `act` while the window has focus and `seen` names something to act
 * on: at once for each new `seen`, and again each time the window regains
 * focus. Nothing while `seen` is undefined.
 */
function useWhileFocused(seen: string | undefined, act: () => void) {
	const actNow = useEffectEvent(act);
	useEffect(() => {
		if (seen === undefined) return;
		const actIfFocused = () => {
			if (document.hasFocus()) actNow();
		};
		actIfFocused();
		window.addEventListener("focus", actIfFocused);
		return () => window.removeEventListener("focus", actIfFocused);
	}, [seen]);
}

/**
 * What marking a conversation read waits on in `item`: a message's id and status, so
 * a reply streaming in marks it once when it arrives and once when it
 * finishes, not at every word.
 */
function readRevision(item: ChatMessageItem): string {
	if (item.kind === "message") return `${item.message.id}:${item.message.status}`;
	// A run seen while it runs is read again once it ends.
	return item.kind === "run" ? `${item.id}:${item.state}` : item.id;
}

/** Fetches again what shows which conversations are unread or done: the lists, the sidebar and the inbox. */
export function refreshConversationMarkers(queries: QueryClient, workspaceId: string | undefined) {
	return Promise.all([
		queries.invalidateQueries({ queryKey: projectThreadsKey(workspaceId) }),
		queries.invalidateQueries({ queryKey: projectMarkersKey(workspaceId) }),
		queries.invalidateQueries({ queryKey: inboxFeedKey(workspaceId) }),
		queries.invalidateQueries({ queryKey: attentionCountsKey(workspaceId) }),
		queries.invalidateQueries({ queryKey: directMessagesKey(workspaceId) }),
	]);
}

/**
 * Fetches every workspace's approvals inbox again, for a request answered
 * where its workspace is not known.
 */
export function refreshEveryApprovalInbox(queries: QueryClient) {
	return Promise.all([
		queries.invalidateQueries({ queryKey: approvalInboxKey() }),
		queries.invalidateQueries({ queryKey: attentionCountsKey() }),
	]);
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
		refreshConversationMarkers(queries, workspaceId),
		queries.invalidateQueries({ queryKey: approvalInboxKey(workspaceId) }),
	]);
}

/**
 * Which kind of conversation is open, and the bot it is with when it has one:
 * a project's thread, one of a bot's threads or automations' feeds, or a
 * direct message between people, one other or a group, with no bot.
 */
type ConversationPlaceKind =
	| { kind: "projectThread" }
	| { kind: "botThread"; bot: Bot }
	| ({ kind: "directMessage" } & DirectPeople);

/** A thread in a project people made. */
interface ProjectPlace {
	project: Project;
	conversation: { kind: "projectThread" };
}

/**
 * One of a bot's threads or automations' feeds, which are its default
 * project's. That project is hidden and has no address of its own, so the
 * place names the bot, and `project` is null.
 */
interface BotPlace {
	project: null;
	conversation: { kind: "botThread"; bot: Bot };
}

/** A conversation with bots in it: in a project, or a bot's own. */
export type ConversationPlace = ProjectPlace | BotPlace;

/** A direct message between people, which belongs to no project, and who is in it. */
interface DirectPlace {
	project: null;
	conversation: Extract<ConversationPlaceKind, { kind: "directMessage" }>;
}

/** The bot a place's conversation is with, if any. */
export function placeBot(place: { conversation: ConversationPlaceKind }): Bot | undefined {
	return place.conversation.kind === "botThread" ? place.conversation.bot : undefined;
}

/**
 * Where the conversation `conversationId` is, in the project at `projectSlug`;
 * `undefined` when there is none or it is not one in that project. Read from
 * the project's list, and from the conversation itself only when the list
 * does not have it, as an archived thread or one of its automations' feeds.
 */
export function useProjectThreadPlace(
	projectSlug: string,
	conversationId: string | undefined,
): { found: ProjectPlace | undefined; isPending: boolean; error: unknown } {
	const projects = useProjects();
	const project = findProject(projects.data, projectSlug);
	const list = useProjectThreads(project?.id);
	const listed =
		list.data?.threads.some((thread) => thread.conversation.id === conversationId) ?? false;
	const unlisted = useQuery({
		...conversationQuery(conversationId),
		enabled: conversationId !== undefined && list.isSuccess && !listed,
	});
	const unlistedKind = unlisted.data?.conversation?.kind;
	const inProject =
		listed ||
		((unlistedKind === "project_thread" || unlistedKind === "automation_feed") &&
			unlisted.data?.conversation?.projectId === project?.id);
	return {
		found: project && inProject ? { project, conversation: { kind: "projectThread" } } : undefined,
		isPending:
			projects.isPending || list.isPending || (list.isSuccess && !listed && unlisted.isPending),
		error: projects.error ?? list.error ?? unlisted.error,
	};
}

/**
 * Where the conversation `conversationId` is when it is one of the bot
 * `bot`'s: one of its threads or automations; `undefined` when it is
 * not.
 */
export function useBotThreadPlace(
	bot: Bot,
	conversationId: string | undefined,
): { found: BotPlace | undefined; isPending: boolean; error: unknown } {
	const list = useProjectThreads(bot.defaultProjectId);
	const listed =
		list.data?.threads.some((item) => item.conversation.id === conversationId) ||
		list.data?.automations.some((item) => item.conversation?.id === conversationId) ||
		false;
	const unlisted = useQuery({
		...conversationQuery(conversationId),
		enabled: conversationId !== undefined && list.isSuccess && !listed,
	});
	const ours = listed || unlisted.data?.conversation?.botId === bot.id;
	return {
		found: ours ? { project: null, conversation: { kind: "botThread", bot } } : undefined,
		isPending: list.isPending || (list.isSuccess && !listed && unlisted.isPending),
		error: list.error ?? unlisted.error,
	};
}

/**
 * Where any conversation `conversationId` is, read from the conversation
 * itself: in a project, a bot's, or a direct message. For a page, such as
 * Inbox's, whose address names only the conversation.
 */
export function useAnyConversationPlace(conversationId: string): {
	found: ConversationPlace | DirectPlace | undefined;
	isPending: boolean;
	error: unknown;
} {
	const projects = useProjects();
	const roster = useBots();
	const opened = useQuery(conversationQuery(conversationId));
	const details = opened.data?.conversation;
	const isDirect = details?.kind === "direct_message";
	const direct = useDirectMessage(conversationId, isDirect);
	if (isDirect) return direct;
	const project = details?.projectId
		? projects.data?.find((one) => one.id === details.projectId)
		: undefined;
	const bot = details?.botId ? roster.bots?.find((one) => one.id === details.botId) : undefined;
	const found: ConversationPlace | undefined = project
		? { project, conversation: { kind: "projectThread" } }
		: bot
			? { project: null, conversation: { kind: "botThread", bot } }
			: undefined;
	return {
		found,
		isPending: opened.isPending || projects.isPending || roster.isPending,
		error: opened.error ?? projects.error ?? roster.error,
	};
}

/**
 * The automation's feed: read from its project's list, `projectId`, when given
 * and it has one, and otherwise opened with a request.
 */
export function useOpenAutomationFeed(projectId: string | undefined, automationId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: automationFeedKey(workspaceId, automationId),
		queryFn: workspaceId
			? async ({ signal }) => {
					const listed = projectId
						? (
								await queries.ensureQueryData(projectThreadsQuery(workspaceId, projectId))
							).automations.find((item) => item.automation.id === automationId)?.conversation
						: undefined;
					return (
						listed ??
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
	void queries.prefetchInfiniteQuery(conversationMessagesQuery(conversationId));
	void queries.prefetchInfiniteQuery(conversationHistoryQuery(conversationId));
	void queries.prefetchQuery(conversationQuery(conversationId));
}

/** The conversation, a page at a time, newest page first. */
function conversationMessagesQuery(conversationId: string | undefined) {
	return infiniteQueryOptions({
		queryKey: conversationMessagesKey(conversationId),
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
function conversationHistoryQuery(conversationId: string | undefined) {
	return infiniteQueryOptions({
		queryKey: conversationHistoryKey(conversationId),
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

export function useConversationMessages(conversationId: string | undefined) {
	const query = useInfiniteQuery(conversationMessagesQuery(conversationId));
	const items = query.data?.pages
		.slice()
		.reverse()
		.flatMap((page) => page?.items ?? []);
	return { ...query, items: items ?? [] };
}

export function useConversationHistory(conversationId: string | undefined) {
	const query = useInfiniteQuery(conversationHistoryQuery(conversationId));
	return {
		...query,
		entries: query.data?.pages.flatMap((page) => page?.items ?? []) ?? [],
	};
}

/**
 * A message to send, with the whole quote it answers and the files it
 * attaches, so it shows both before the API answers.
 */
type MessageToSend = Omit<NewMessage, "replyTo" | "attachments"> & {
	replyTo?: MessageReplyTo;
	files?: readonly FilePart[];
};

export function useSendMessage(conversationId: string, user: SessionUser) {
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
			await queries.cancelQueries({ queryKey: conversationMessagesKey(conversationId) });
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
						queries.getQueryData<ConversationDetails>(conversationQuery(conversationId).queryKey)
							?.messages ?? [],
					),
				},
			};
			queries.setQueryData(
				optimisticMessagesKey(conversationId),
				(items: ChatMessageItem[] = []) => [...items, optimistic],
			);
		},
		onSettled: async (_result, _error, input) => {
			queries.setQueryData<ChatMessageItem[]>(optimisticMessagesKey(conversationId), (items) =>
				items?.filter((item) => item.kind !== "message" || item.message.id !== input.id),
			);
			await Promise.all([
				queries.invalidateQueries({ queryKey: conversationMessagesKey(conversationId) }),
				queries.invalidateQueries({ queryKey: conversationHistoryKey(conversationId) }),
				queries.invalidateQueries({ queryKey: conversationQuery(conversationId).queryKey }),
				queries.invalidateQueries({ queryKey: projectThreadsKey(workspaceId) }),
			]);
		},
	});
}

/** What the composer says when the API did not start a thread. */
export const THREAD_NOT_STARTED = "The thread was not started. Your draft is still here.";

/**
 * How starting a thread from a draft went: started; refused by the API; or not
 * sent, because the draft has no words to title it.
 */
type ThreadStart =
	| { outcome: "started"; thread: StartedThread }
	| { outcome: "refused" }
	| { outcome: "notSent" };

/**
 * Starts threads with a bot, or in a project, each with a draft as its first
 * message; files are added once it has started. The bot's or project's list
 * shows each thread once it has.
 */
export function useThreadStarter(starting: { projectId: string }) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const startThread = useMutation({
		mutationFn: (payload: FirstThreadMessage) =>
			Effect.runPromise(
				client.api.chats.startProjectThread({ params: { projectId: starting.projectId }, payload }),
			),
		onSettled: () => queries.invalidateQueries({ queryKey: projectThreadsKey(workspaceId) }),
	});
	async function start(draft: string): Promise<ThreadStart> {
		const message = draft.trim();
		if (startThread.isPending || message === "") return { outcome: "notSent" };
		try {
			const thread = await startThread.mutateAsync({ id: uuidv4(), message });
			return { outcome: "started", thread };
		} catch {
			return { outcome: "refused" };
		}
	}
	return { start, isPending: startThread.isPending };
}

/**
 * Starts the thread in which a bot its maker just made interviews them, when
 * the bot is due one; resolves to the thread, or null.
 */
export function useStartInterview() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (botId: string) =>
			Effect.runPromise(client.api.chats.startInterview({ params: { botId } })),
		onSettled: () => queries.invalidateQueries({ queryKey: projectThreadsKey(workspaceId) }),
	});
}

/** Marks the thread done, or reopens it. The thread and the lists show it once it has. */
export function useSetDone(conversationId: string) {
	const refresh = useRefreshThread(conversationId);
	return useMutation({
		mutationFn: (done: boolean) =>
			Effect.runPromise(
				done
					? client.api.chats.markDone({ params: { conversationId } })
					: client.api.chats.reopen({ params: { conversationId } }),
			),
		onSettled: refresh,
	});
}

/**
 * What an automation's feed does with its automation: run it again, which
 * turns on one that paused itself after failing, pause or resume it, and
 * rename it.
 * `pending` is shared by every control of the automation on screen, so none
 * starts another change while one is on its way. The feed is fetched again
 * after each; the automation's own actions refresh the lists it is in.
 */
export function useAutomationControls(
	/** Its feed, or undefined where it is controlled without one. */
	conversationId: string | undefined,
	automation: { id: string; projectId: string },
) {
	const queries = useQueryClient();
	const actions = useAutomationActions();
	const mutationKey = ["automation-controls", automation.id];
	const refresh = () =>
		conversationId &&
		Promise.all([
			queries.invalidateQueries({ queryKey: conversationQuery(conversationId).queryKey }),
			queries.invalidateQueries({ queryKey: conversationMessagesKey(conversationId) }),
		]);
	const scope = { projectId: automation.projectId, automationId: automation.id };
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

/** Renames the thread `conversationId`. The lists and the thread show it once it has. */
export function useRenameThread(conversationId: string) {
	const refresh = useRefreshThread(conversationId);
	return useMutation({
		mutationFn: (name: string) =>
			Effect.runPromise(
				client.api.chats.renameThread({ params: { conversationId }, payload: { name } }),
			),
		onSettled: refresh,
	});
}

/** Archives the thread `conversationId`, which takes it off its project's list. */
export function useArchiveThread(conversationId: string) {
	const refresh = useRefreshThread(conversationId);
	return useMutation({
		mutationFn: () =>
			Effect.runPromise(client.api.chats.archiveThread({ params: { conversationId } })),
		onSettled: refresh,
	});
}

/** Fetches again what shows a thread as it is: the thread, and the lists and markers it is in. */
function useRefreshThread(conversationId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return () =>
		Promise.all([
			queries.invalidateQueries({ queryKey: conversationQuery(conversationId).queryKey }),
			refreshConversationMarkers(queries, workspaceId),
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
		queryKey: optimisticMessagesKey(conversationId),
		queryFn: skipToken,
		initialData: [],
	});
	return query.data ?? [];
}

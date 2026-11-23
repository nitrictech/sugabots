import {
	type AttentionCounts,
	type AttentionMark,
	type AutomationUpdate,
	type Bot,
	type ChatDetails,
	type ChatMessageItem,
	type FilePart,
	type FirstChatMessage,
	handleFromName,
	type ListedChat,
	type MessageReplyTo,
	type NewMessage,
	type PersonParticipant,
	type Project,
	type SignedInPerson,
	type StartedChat,
} from "@sugabots/contracts";
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
import { useEffect, useEffectEvent, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import { client } from "@/api.ts";
import { pollWhileAutomationsRun, useAutomationActions } from "@/lib/automations.ts";
import { useBots } from "@/lib/bots.ts";
import { chatQuery } from "@/lib/chat-query.ts";
import { findProject, useProjects } from "@/lib/projects.ts";
import type { ResourceOwner } from "@/lib/resource-owner.tsx";
import { useWorkspace } from "@/lib/workspace.ts";

const PAGE_SIZE = 30;
const RUNNING_CHAT_HISTORY_REFETCH_INTERVAL_MS = 1_000;

/*
 * The keys of the queries below. Each takes its scope from the widest part to
 * the narrowest, and a shorter key matches every query under it, so
 * `projectChatsKey(workspaceId)` refreshes every project's list there.
 */

export const projectChatsKey = (...scope: [workspaceId?: string, projectId?: string]) => [
	"project-chats",
	...scope,
];
const attentionCountsKey = (...scope: [workspaceId?: string]) => ["attention-counts", ...scope];
const attentionMarksKey = (workspaceId: string | undefined) => ["attention-marks", workspaceId];
const workspaceApprovalsKey = (...scope: [workspaceId?: string]) => [
	"workspace-approvals",
	...scope,
];
const chatMessagesKey = (...scope: [chatId?: string]) => ["chat-messages", ...scope];
const chatHistoryKey = (...scope: [chatId?: string]) => ["chat-history", ...scope];
const optimisticMessagesKey = (chatId: string | undefined) => ["optimistic-messages", chatId];
const automationFeedKey = (workspaceId: string | undefined, automationId: string) => [
	"automation-feed",
	workspaceId,
	automationId,
];

/**
 * A project's chats, the newest message first, and its automations, by the
 * project's id: a bot's are its default project's.
 */
function projectChatsQuery(workspaceId: string | undefined, projectId: string | undefined) {
	return queryOptions({
		queryKey: projectChatsKey(workspaceId, projectId),
		queryFn:
			workspaceId && projectId
				? ({ signal }) =>
						Effect.runPromise(client.api.chats.projectChats({ params: { projectId } }), { signal })
				: skipToken,
		refetchInterval: (query) => pollWhileAutomationsRun(query.state.data?.automations),
	});
}

/**
 * A project's chats, the newest message first, and its
 * automations, by its id; a bot's by its default project's. Read again while
 * one of its automations runs. Nothing is asked while it is undefined.
 */
export function useProjectChats(projectId: string | undefined) {
	return useQuery(projectChatsQuery(useWorkspace().workspace?.id, projectId));
}

/** Whether an open chat waits on the viewer: a tool call for them to approve, or a mention of them. */
export function needsViewer(row: ListedChat): boolean {
	return row.chat.resolvedAt === null && (row.needsApproval || row.mentionsYou);
}

/** When a chat last had something in it: its newest message, else when it was started. */
export function lastMovedAt(row: ListedChat): number {
	return Date.parse(row.lastMessage?.at ?? row.chat.createdAt);
}

/** How a project stands while the attention marks have nothing for it, or have not loaded. */
const NO_ATTENTION_MARK: AttentionMark = {
	unreadMessages: 0,
	needsApproval: false,
	failedAutomations: 0,
};

/**
 * How each project stands for the sidebar, by its id: its unread messages,
 * whether any chat waits on the person, and how many of its
 * automations are failing unseen. A bot's is its default project's.
 */
export function useAttentionMarks(): { attentionMarkOf: (projectId: string) => AttentionMark } {
	const workspaceId = useWorkspace().workspace?.id;
	const { data } = useQuery({
		queryKey: attentionMarksKey(workspaceId),
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.chats.attentionMarks({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
	return { attentionMarkOf: (projectId) => data?.projects[projectId] ?? NO_ATTENTION_MARK };
}

/**
 * The approvals across the workspace: those waiting on the person, and the
 * latest answered.
 */
export function useWorkspaceApprovals() {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: workspaceApprovalsKey(workspaceId),
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.chats.approvals({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

/** A person, as a message's author or somebody it is written to. */
function personParticipantOf(person: {
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

/** How much waits for the person while the counts are loading: nothing. */
const NO_ATTENTION: AttentionCounts = {
	waitingApprovals: 0,
	unreadForYou: 0,
};

/**
 * How much in the workspace is waiting for the person, which the app's badge
 * and the Approvals tab count.
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
 * Records that the person has read the chat up to its newest message, and
 * clears its dot and its count in the sidebar.
 */
function useMarkChatRead(chatId: string | undefined) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: () =>
			chatId
				? Effect.runPromise(client.api.chats.markRead({ params: { chatId } }))
				: Promise.resolve(),
		onSuccess: () => refreshListsAndAttention(queries, workspaceId),
	});
}

/**
 * Marks one automation run or collaboration read, by its own chat, while the
 * window has focus, without reading the rest of the chat it is in.
 * Checks when the nested chat opens and when the window gains focus.
 */
export function useMarkNestedChatReadWhileSeen(nestedChatId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const { mutate } = useMutation({
		mutationFn: (chatId: string) =>
			Effect.runPromise(client.api.chats.markNestedChatRead({ params: { chatId } })),
		onSuccess: () => refreshListsAndAttention(queries, workspaceId),
	});
	useWhileFocused(nestedChatId, () => mutate(nestedChatId));
}

/**
 * Marks the chat read while the person can see `newest`, its latest item: the
 * window has focus and `latestInView` holds. Checks when it opens, when
 * `newest` arrives or finishes, when `latestInView` turns true, and when the
 * window gains focus.
 *
 * Focus, not visibility: a window beside the one being worked in is visible,
 * and what arrives there is unseen until the person comes back to it.
 */
export function useMarkReadWhileSeen(
	chatId: string | undefined,
	newest: ChatMessageItem | undefined,
	latestInView: boolean,
) {
	const { mutate } = useMarkChatRead(chatId);
	const seen = chatId && newest && latestInView ? `${chatId}:${readRevision(newest)}` : undefined;
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
 * What marking a chat read waits on in `item`: a message's id and status, so
 * a reply arriving on the token stream marks it once when it arrives and once when it
 * finishes, not at every word.
 */
function readRevision(item: ChatMessageItem): string {
	if (item.kind === "message") return `${item.message.id}:${item.message.status}`;
	// A run seen while it runs is read again once it ends.
	return item.kind === "run" ? `${item.id}:${item.state}` : item.id;
}

/** Fetches again what shows which chats are unread or resolved: the lists, the sidebar and the app's badge. */
export function refreshListsAndAttention(queries: QueryClient, workspaceId: string | undefined) {
	return Promise.all([
		queries.invalidateQueries({ queryKey: projectChatsKey(workspaceId) }),
		queries.invalidateQueries({ queryKey: attentionMarksKey(workspaceId) }),
		queries.invalidateQueries({ queryKey: attentionCountsKey(workspaceId) }),
	]);
}

/**
 * Fetches every workspace's approvals again, for a request answered
 * where its workspace is not known.
 */
export function refreshEveryWorkspaceApprovals(queries: QueryClient) {
	return Promise.all([
		queries.invalidateQueries({ queryKey: workspaceApprovalsKey() }),
		queries.invalidateQueries({ queryKey: attentionCountsKey() }),
	]);
}

/**
 * Fetches again everything a change in one of the workspace's chats can
 * move: the chats' attention marks, and the workspace's approvals.
 */
export function refreshAfterChatChange(queries: QueryClient, workspaceId: string | undefined) {
	return Promise.all([
		refreshListsAndAttention(queries, workspaceId),
		queries.invalidateQueries({ queryKey: workspaceApprovalsKey(workspaceId) }),
	]);
}

/**
 * Whose a chat is: a project people made, for its chats and its
 * automations' feeds; or a bot, for its own, which are its default project's.
 * That project is hidden and has no address of its own, so the place names the bot.
 */
export type ChatLocation = ResourceOwner;

/** The bot a place's chat is with, if any. */
export function placeBot(place: ChatLocation): Bot | undefined {
	return "bot" in place ? place.bot : undefined;
}

/**
 * Where the chat `chatId` is, in the project at `projectSlug`;
 * `undefined` when there is none or it is not one in that project.
 */
export function useProjectChatPlace(
	projectSlug: string,
	chatId: string | undefined,
): { found: { project: Project } | undefined; isPending: boolean; error: unknown } {
	const projects = useProjects();
	const project = findProject(projects.data, projectSlug);
	const { inProject, isPending, error } = useChatInProject(project?.id, chatId);
	return {
		found: project && inProject ? { project } : undefined,
		isPending: projects.isPending || isPending,
		error: projects.error ?? error,
	};
}

/**
 * Where the chat `chatId` is when it is one of the bot
 * `bot`'s: one of its chats or automations; `undefined` when it is
 * not.
 */
export function useBotChatPlace(
	bot: Bot,
	chatId: string | undefined,
): { found: { bot: Bot } | undefined; isPending: boolean; error: unknown } {
	const { inProject, isPending, error } = useChatInProject(bot.defaultProjectId, chatId);
	return { found: inProject ? { bot } : undefined, isPending, error };
}

/**
 * Whether the chat `chatId` is in the project `projectId`, a
 * bot's default one or one people made: one of its chats or automations'
 * feeds. Read from the project's list, and from the chat itself only
 * when the list does not have it, such as one started since the list was read.
 */
function useChatInProject(
	projectId: string | undefined,
	chatId: string | undefined,
): { inProject: boolean; isPending: boolean; error: unknown } {
	const list = useProjectChats(projectId);
	const listed =
		list.data?.chats.some((item) => item.chat.id === chatId) ||
		list.data?.automations.some((item) => item.chat?.id === chatId) ||
		false;
	const unlisted = useQuery({
		...chatQuery(chatId),
		enabled: chatId !== undefined && list.isSuccess && !listed,
	});
	// By its project, not its bot, which on a collaboration names the bot asked, whoever's chat it hangs under.
	const unlistedKind = unlisted.data?.chat?.kind;
	const inProject =
		listed ||
		((unlistedKind === "project_chat" || unlistedKind === "automation_feed") &&
			unlisted.data?.chat?.projectId === projectId);
	return {
		inProject,
		isPending: list.isPending || (list.isSuccess && !listed && unlisted.isPending),
		error: list.error ?? unlisted.error,
	};
}

/**
 * Where any chat `chatId` is, read from the chat
 * itself: in a project, or a bot's. For a page whose address names only
 * the chat.
 */
export function useAnyChatLocation(chatId: string): {
	found: ChatLocation | undefined;
	isPending: boolean;
	error: unknown;
} {
	const projects = useProjects();
	const roster = useBots();
	const opened = useQuery(chatQuery(chatId));
	const details = opened.data?.chat;
	const project = details?.projectId
		? projects.data?.find((one) => one.id === details.projectId)
		: undefined;
	const bot = details?.botId ? roster.bots?.find((one) => one.id === details.botId) : undefined;
	const found: ChatLocation | undefined = project ? { project } : bot ? { bot } : undefined;
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
								await queries.ensureQueryData(projectChatsQuery(workspaceId, projectId))
							).automations.find((item) => item.automation.id === automationId)?.chat
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
 * Starts loading the chat an address names: as its page first loads,
 * and for a link the pointer is on, so it is on screen when the click lands.
 * A failure is left for the screen's own queries to meet and show.
 */
export function prefetchChat(queries: QueryClient, chatId: string): void {
	void queries.prefetchInfiniteQuery(chatMessagesQuery(chatId));
	void queries.prefetchInfiniteQuery(chatHistoryQuery(chatId));
	void queries.prefetchQuery(chatQuery(chatId));
}

/** The chat, a page at a time, newest page first. */
function chatMessagesQuery(chatId: string | undefined) {
	return infiniteQueryOptions({
		queryKey: chatMessagesKey(chatId),
		queryFn: chatId
			? ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
					Effect.runPromise(
						client.api.chats.messages({
							params: { chatId },
							query: { limit: PAGE_SIZE, cursor: pageParam },
						}),
						{ signal },
					)
			: skipToken,
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page?.nextCursor ?? undefined,
	});
}

/** The runs and collaborations opened beside the chat, a page at a time, newest activity first. */
function chatHistoryQuery(chatId: string | undefined) {
	return infiniteQueryOptions({
		queryKey: chatHistoryKey(chatId),
		refetchInterval: (current) =>
			current.state.data?.pages.some((page) =>
				page?.items.some((entry) => entry.status === "queued" || entry.status === "running"),
			)
				? RUNNING_CHAT_HISTORY_REFETCH_INTERVAL_MS
				: false,
		queryFn: chatId
			? ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
					Effect.runPromise(
						client.api.chats.history({
							params: { chatId },
							query: { limit: PAGE_SIZE, cursor: pageParam },
						}),
						{ signal },
					)
			: skipToken,
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page?.nextCursor ?? undefined,
	});
}

export function useChatMessages(chatId: string | undefined) {
	const query = useInfiniteQuery(chatMessagesQuery(chatId));
	const items = query.data?.pages
		.slice()
		.reverse()
		.flatMap((page) => page?.items ?? []);
	return { ...query, items: items ?? [] };
}

export function useChatHistory(chatId: string | undefined) {
	const query = useInfiniteQuery(chatHistoryQuery(chatId));
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

export function useSendMessage(chatId: string, signedIn: SignedInPerson) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: async ({ replyTo, files = [], ...message }: MessageToSend) => {
			const payload: NewMessage = {
				...message,
				...(replyTo && { replyTo: replyTo.id }),
				...(files.length > 0 && { attachments: files.map((file) => file.id) }),
			};
			return Effect.runPromise(client.api.chats.send({ params: { chatId }, payload }));
		},
		onMutate: async (input) => {
			await queries.cancelQueries({ queryKey: chatMessagesKey(chatId) });
			const optimistic: ChatMessageItem = {
				kind: "message",
				message: {
					id: input.id,
					chatId,
					author: personParticipantOf(signedIn),
					kind: "text",
					status: "complete",
					parts: [
						...(input.message === "" ? [] : [{ type: "text" as const, text: input.message }]),
						...(input.files ?? []),
					],
					content: input.message,
					...(input.replyTo ? { replyTo: input.replyTo } : {}),
					createdAt: timestampAfter(
						queries.getQueryData<ChatDetails>(chatQuery(chatId).queryKey)?.messages ?? [],
					),
				},
			};
			queries.setQueryData(optimisticMessagesKey(chatId), (items: ChatMessageItem[] = []) => [
				...items,
				optimistic,
			]);
		},
		onSettled: async (_result, _error, input) => {
			queries.setQueryData<ChatMessageItem[]>(optimisticMessagesKey(chatId), (items) =>
				items?.filter((item) => item.kind !== "message" || item.message.id !== input.id),
			);
			await Promise.all([
				queries.invalidateQueries({ queryKey: chatMessagesKey(chatId) }),
				queries.invalidateQueries({ queryKey: chatHistoryKey(chatId) }),
				queries.invalidateQueries({ queryKey: chatQuery(chatId).queryKey }),
				queries.invalidateQueries({ queryKey: projectChatsKey(workspaceId) }),
			]);
		},
	});
}

/** What the composer says when the API did not start a chat. */
export const CHAT_NOT_STARTED = "The chat was not started. Your draft is still here.";

/**
 * How starting a chat from a draft went: started; refused by the API; or not
 * sent, because the draft has no words to title it.
 */
type ChatStart =
	| { outcome: "started"; chat: StartedChat }
	| { outcome: "refused" }
	| { outcome: "notSent" };

/**
 * Starts chats with a bot, or in a project, each with a draft as its first
 * message; files are added once it has started. The bot's or project's list
 * shows each chat once it has.
 */
export function useChatStarter(starting: { projectId: string }) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const startChat = useMutation({
		mutationFn: (payload: FirstChatMessage) =>
			Effect.runPromise(
				client.api.chats.startProjectChat({ params: { projectId: starting.projectId }, payload }),
			),
		onSettled: () => queries.invalidateQueries({ queryKey: projectChatsKey(workspaceId) }),
	});
	/**
	 * The last draft sent that did not come back started, with its message's id.
	 * Its chat may have started all the same, its answer lost, so sending the
	 * same draft to the same project again reuses the id, which the API answers
	 * with the chat it started rather than starting a second.
	 */
	const unconfirmed = useRef<{ projectId: string; message: string; id: string }>(undefined);
	async function start(draft: string): Promise<ChatStart> {
		const message = draft.trim();
		if (startChat.isPending || message === "") return { outcome: "notSent" };
		const retried = unconfirmed.current;
		const id =
			retried?.projectId === starting.projectId && retried.message === message
				? retried.id
				: uuidv4();
		unconfirmed.current = { projectId: starting.projectId, message, id };
		try {
			const chat = await startChat.mutateAsync({ id, message });
			unconfirmed.current = undefined;
			return { outcome: "started", chat };
		} catch {
			return { outcome: "refused" };
		}
	}
	return { start, isPending: startChat.isPending };
}

/**
 * Starts the chat in which a bot its maker just made interviews them, when
 * the bot is due one; resolves to the chat, or null.
 */
export function useStartInterview() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (botId: string) =>
			Effect.runPromise(client.api.chats.startInterview({ params: { botId } })),
		onSettled: () => queries.invalidateQueries({ queryKey: projectChatsKey(workspaceId) }),
	});
}

/** Marks the chat resolved, or reopens it. The chat and the lists show it once it has. */
export function useSetResolved(chatId: string) {
	const refresh = useRefreshChat(chatId);
	return useMutation({
		mutationFn: (resolved: boolean) =>
			Effect.runPromise(
				resolved
					? client.api.chats.markResolved({ params: { chatId } })
					: client.api.chats.reopen({ params: { chatId } }),
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
	chatId: string | undefined,
	automation: { id: string; projectId: string },
) {
	const queries = useQueryClient();
	const actions = useAutomationActions();
	const mutationKey = ["automation-controls", automation.id];
	const refresh = () =>
		chatId &&
		Promise.all([
			queries.invalidateQueries({ queryKey: chatQuery(chatId).queryKey }),
			queries.invalidateQueries({ queryKey: chatMessagesKey(chatId) }),
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

/** Renames the chat `chatId`. The lists and the chat show it once it has. */
export function useRenameChat(chatId: string) {
	const refresh = useRefreshChat(chatId);
	return useMutation({
		mutationFn: (name: string) =>
			Effect.runPromise(client.api.chats.renameChat({ params: { chatId }, payload: { name } })),
		onSettled: refresh,
	});
}

/** Fetches again what shows a chat as it is: the chat, and the lists and attention marks it is in. */
function useRefreshChat(chatId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return () =>
		Promise.all([
			queries.invalidateQueries({ queryKey: chatQuery(chatId).queryKey }),
			refreshListsAndAttention(queries, workspaceId),
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

export function useOptimisticChatItems(chatId: string | undefined): ChatMessageItem[] {
	const query = useQuery<ChatMessageItem[]>({
		queryKey: optimisticMessagesKey(chatId),
		queryFn: skipToken,
		initialData: [],
	});
	return query.data ?? [];
}

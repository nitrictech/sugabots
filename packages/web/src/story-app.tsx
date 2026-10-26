import type {
	Agent,
	ChatListItem,
	ChatMessageItem,
	ConversationThread,
	Message,
	ModelProvider,
	Pod,
	PodChat,
	SessionUser,
	SystemAgent,
	ThreadActivity,
	ThreadDetails,
	WorkspacePermissions,
	WorkspaceRole,
} from "@sugabots/contracts";
import {
	connectionWithTools,
	listedConnection,
	type TestConnection,
	testPerson,
} from "@sugabots/contracts/testing";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, type RequestHandler } from "msw";
import { useEffect, useState } from "react";
import { chatItemCreatedAt } from "@/lib/chats.ts";
import { createQueryClient } from "@/lib/query.ts";
import { AppRouterProvider, createAppRouter } from "@/router.tsx";
import { podsWithBots } from "@/shell/story-fixtures.ts";

/*
 * The whole app, for a story: the real routes at an address, answered by
 * `appHandlers` through the Storybook MSW worker. A story that shows a screen
 * as it appears in the app, with its rail, list and settings around it, uses
 * this rather than rendering the screen alone and guessing at its context.
 *
 * Fixtures are the design's example workspace, from `story-fixtures.ts`.
 */

const API = import.meta.env.VITE_API_URL as string;
const api = (path: string) => `${API}${path}`;

export const storyUser: SessionUser = {
	id: "0199a3a0-0000-7000-8000-000000000009",
	name: "Ryan Eyes",
	email: "ryan@nitric.io",
	image: null,
} as SessionUser;

const firstPod = podsWithBots[0]?.pod as Pod;

export const storyWorkspace = {
	id: firstPod.workspaceId,
	name: "Nitric",
	slug: "nitric",
	timeZone: "UTC",
	setupCompletedAt: "2026-09-01T00:00:00.000Z",
};

/** Every pod, with the viewer as the Personal pod's owner, and every bot. */
export const storyPods: Pod[] = podsWithBots.map(({ pod }) =>
	pod.kind === "personal" ? { ...pod, ownerId: storyUser.id } : pod,
);
export const storyBots: Agent[] = podsWithBots.flatMap(({ bots }) => bots);

/** One thread per bot, by the bot's id. */
export function storyConversationFor(agent: Agent): ConversationThread {
	const suffix = agent.id.slice(-4);
	return {
		kind: "thread",
		id: `0199a3a0-0000-7000-8000-00000000c${suffix.slice(1)}`,
		workspaceId: agent.workspaceId,
		podId: agent.podId,
		hostAgentId: agent.id,
		title: `Conversation with ${agent.name}`,
		doneAt: null,
		createdAt: "2026-09-18T06:00:00.000Z",
		updatedAt: "2026-09-18T06:10:00.000Z",
	};
}

export const storyModel = {
	providerId: "0199a3a0-0000-7000-8000-000000000201",
	providerName: "Anthropic",
	providerPreset: "anthropic",
	providerActive: true,
	modelId: "claude-sonnet-4-20250514",
	displayName: "Claude Sonnet",
};

const systemAgents: SystemAgent[] = (["summarise", "compact"] as const).map((key) => ({
	key,
	name: key === "summarise" ? "Scribe" : "Compaction",
	description: null,
	color: "ice",
	face: "pill",
	shape: "circle",
	model: storyModel.modelId,
}));

const NO_PERMISSIONS: WorkspacePermissions = {
	createPods: false,
	manageProviders: false,
	manageMembers: false,
	configureBuiltInAgents: false,
	manageUsage: false,
	manageAdmins: false,
	transferOwnership: false,
	deleteWorkspace: false,
};

/** What each role may do in the workspace, as the API's grant tables decide it. */
const PERMISSIONS_BY_ROLE: Record<WorkspaceRole, WorkspacePermissions> = {
	owner: {
		createPods: true,
		manageProviders: true,
		manageMembers: true,
		configureBuiltInAgents: true,
		manageUsage: true,
		manageAdmins: true,
		transferOwnership: true,
		deleteWorkspace: true,
	},
	admin: {
		createPods: true,
		manageProviders: true,
		manageMembers: true,
		configureBuiltInAgents: true,
		manageUsage: true,
		manageAdmins: false,
		transferOwnership: false,
		deleteWorkspace: false,
	},
	member: NO_PERMISSIONS,
	viewer: NO_PERMISSIONS,
};

/** What a chat's thread holds: its messages, and who is in it. */
export function storyChatDetails(agent: Agent, messages: Message[] = []): ThreadDetails {
	const chat = storyConversationFor(agent);
	const bot = {
		kind: "agent" as const,
		id: agent.id,
		name: agent.name,
		handle: agent.handle,
		color: agent.color,
		face: agent.face,
		shape: agent.shape,
	};
	const person = testPerson({ id: storyUser.id, name: storyUser.name });
	return {
		thread: {
			id: chat.id,
			workspaceId: agent.workspaceId,
			podId: agent.podId,
			hostAgentId: agent.id,
			conversationId: chat.id,
			type: "conversation",
			title: chat.title,
			status: "done",
			parentThreadId: null,
			initiatorUserId: storyUser.id,
			doneAt: null,
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
		},
		capabilities: { approveToolCalls: true },
		routineExecution: null,
		startedFrom: null,
		participants: [person, bot],
		crew: [bot],
		members: [],
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
		messages,
	};
}

/** A shared pod's chat, by the pod's id. */
export function storyPodChatFor(pod: Pod): PodChat {
	return {
		kind: "pod_chat",
		id: `0199a3a0-0000-7000-8000-00000000c9${pod.id.slice(-2)}`,
		workspaceId: pod.workspaceId,
		podId: pod.id,
		title: "General",
		main: true,
		archivedAt: null,
		createdAt: "2026-09-18T06:00:00.000Z",
		updatedAt: "2026-09-18T06:10:00.000Z",
	};
}

/** What a pod's chat holds: its messages, and the pod's people and bots to mention. */
export function storyPodChatDetails(
	pod: Pod,
	bots: Agent[],
	messages: Message[] = [],
): ThreadDetails {
	const chat = storyPodChatFor(pod);
	const person = testPerson({ id: storyUser.id, name: storyUser.name });
	return {
		thread: {
			id: chat.id,
			workspaceId: chat.workspaceId,
			podId: chat.podId,
			hostAgentId: null,
			title: chat.title,
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
			conversationId: chat.id,
			type: "pod_chat",
			status: "done",
			parentThreadId: null,
			initiatorUserId: storyUser.id,
			doneAt: null,
		},
		capabilities: { approveToolCalls: true },
		routineExecution: null,
		startedFrom: null,
		participants: [person],
		crew: bots
			.filter((bot) => bot.podId === pod.id)
			.map((bot) => ({
				kind: "agent" as const,
				id: bot.id,
				name: bot.name,
				handle: bot.handle,
				color: bot.color,
				face: bot.face,
				shape: bot.shape,
			})),
		members: [person],
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
		messages,
	};
}

/** What a chat's sidebar shows: a summary, and who has written lately. */
export function storyChatActivity(agent: Agent, messages: Message[] = []): ThreadActivity {
	const chat = storyConversationFor(agent);
	const details = storyChatDetails(agent, messages);
	return {
		summary: {
			content: `${agent.name} has been keeping things moving.`,
			sourceMessageId: messages.at(-1)?.id ?? chat.id,
			updatedAt: chat.updatedAt,
		},
		context: null,
		recentParticipants: [...details.participants].reverse(),
	};
}

/** A stream that stays open and says nothing, as a quiet thread's does. */
function quietStream() {
	return new HttpResponse(new ReadableStream({ start() {} }), {
		headers: { "content-type": "text/event-stream" },
	});
}

export interface StoryAppData {
	role?: WorkspaceRole;
	pods?: Pod[];
	bots?: Agent[];
	/** Messages in each bot's chat, by the bot's id. */
	messages?: Record<string, Message[]>;
	/** Messages in each shared pod's chat, by the pod's id. */
	podChatMessages?: Record<string, Message[]>;
	/** Threads started from each shared pod's chat, by the pod's id, as the chat links to them. */
	podChatThreads?: Record<string, Extract<ChatMessageItem, { kind: "thread" }>[]>;
	providers?: ModelProvider[];
	models?: (typeof storyModel)[];
	/** The viewer's referral link, where the installation signs people up by referral. */
	referralLink?: string;
}

/**
 * The API as the app's example workspace answers it. Pass overrides for what
 * a story is about; put handlers of the story's own before these to answer
 * something else.
 */
export function appHandlers(data: StoryAppData = {}): RequestHandler[] {
	const pods = data.pods ?? storyPods;
	const bots = data.bots ?? storyBots;
	const messages = data.messages ?? {};
	const botById = (id: string) => bots.find((bot) => bot.id === id);
	const botForThread = (threadId: string) =>
		bots.find((bot) => storyConversationFor(bot).id === threadId);
	const podForChat = (threadId: string) =>
		pods.find((pod) => pod.kind === "shared" && storyPodChatFor(pod).id === threadId);

	return [
		http.get(api("/workspaces"), () => HttpResponse.json([storyWorkspace])),
		http.get(api("/workspaces/:workspace/members"), () =>
			HttpResponse.json([
				{
					id: "0199a3a0-0000-7000-8000-0000000000d1",
					role: data.role ?? "owner",
					user: storyUser,
					joinedAt: "2026-09-01T00:00:00.000Z",
				},
			]),
		),
		http.get(api("/workspaces/:workspace/invitations"), () => HttpResponse.json([])),
		http.get(api("/referral-link"), () => HttpResponse.json({ url: data.referralLink ?? null })),
		http.get(api("/workspaces/:workspace/me"), () =>
			HttpResponse.json({
				role: data.role ?? "owner",
				permissions: PERMISSIONS_BY_ROLE[data.role ?? "owner"],
			}),
		),
		http.get(api("/workspaces/:workspace/pods"), () => HttpResponse.json(pods)),
		http.get(api("/workspaces/:workspace/agents"), () => HttpResponse.json(bots)),
		http.get(api("/workspaces/:workspace/model-providers/models"), () => {
			const models = data.models ?? [storyModel];
			return HttpResponse.json({ models, defaultModel: models[0]?.modelId ?? null });
		}),
		http.get(api("/workspaces/:workspace/model-providers"), () =>
			HttpResponse.json(data.providers ?? []),
		),
		http.get(api("/workspaces/:workspace/system-agents"), () => HttpResponse.json(systemAgents)),
		http.get(api("/workspaces/:workspace/routines"), () => HttpResponse.json({ items: [] })),
		http.get(api("/workspaces/:workspace/search-provider"), () => HttpResponse.json(null)),
		http.get(api("/workspaces/:workspace/events"), quietStream),
		http.get(api("/workspaces/:workspace/chats/activity"), () => HttpResponse.json({ items: [] })),
		http.get(api("/workspaces/:workspace/chats/approvals"), () =>
			HttpResponse.json({ waiting: [], answered: [] }),
		),
		http.get(api("/workspaces/:workspace/chats/pod-markers"), () =>
			HttpResponse.json({ pods: {} }),
		),
		http.post(
			api("/conversations/:conversationId/read"),
			() => new HttpResponse(null, { status: 204 }),
		),
		http.get(api("/workspaces/:workspace/chats"), ({ request }) => {
			// By the pod's id or its slug, as the API takes it.
			const named = new URL(request.url).searchParams.get("pod");
			const pod = pods.find((one) => one.id === named || one.slug === named);
			// A conversation with each bot somebody has written to.
			const items: ChatListItem[] = bots
				.filter((bot) => bot.podId === pod?.id)
				.flatMap((bot) => {
					const last = messages[bot.id]?.at(-1);
					if (!last) return [];
					return [
						{
							agent: bot,
							conversation: storyConversationFor(bot),
							lastMessage: {
								preview: last.content,
								authorUserId: last.author.kind === "person" ? last.author.id : null,
								at: last.createdAt,
							},
							waitingOn: null,
							unreadMessages: 0,
							needsApproval: false,
							mentionsYou: false,
						},
					];
				});
			return HttpResponse.json({
				routines: [],
				chats:
					pod?.kind === "shared" ? [{ conversation: storyPodChatFor(pod), unreadMessages: 0 }] : [],
				threads: items,
			});
		}),
		http.post(api("/workspaces/:workspace/pods/:podId/chat"), ({ params }) => {
			const pod = pods.find((one) => one.id === params.podId);
			return pod
				? HttpResponse.json(storyPodChatFor(pod))
				: new HttpResponse(null, { status: 404 });
		}),
		http.post(api("/workspaces/:workspace/conversations"), async ({ request }) => {
			const body = (await request.json()) as { hostAgentId: string };
			const bot = botById(body.hostAgentId);
			return bot
				? HttpResponse.json(storyConversationFor(bot))
				: new HttpResponse(null, { status: 404 });
		}),
		http.get(api("/conversations/:conversationId/messages"), ({ params }) => {
			const bot = botForThread(String(params.conversationId));
			const pod = podForChat(String(params.conversationId));
			const said = bot ? messages[bot.id] : pod ? data.podChatMessages?.[pod.id] : undefined;
			const links = pod ? (data.podChatThreads?.[pod.id] ?? []) : [];
			return HttpResponse.json({
				items: [
					...(said ?? []).map((message): ChatMessageItem => ({ kind: "message", message })),
					...links,
				].sort((left, right) => chatItemCreatedAt(left).localeCompare(chatItemCreatedAt(right))),
				nextCursor: null,
			});
		}),
		http.post(api("/conversations/:conversationId/threads"), async ({ params, request }) => {
			const pod = podForChat(String(params.conversationId));
			const body = (await request.json()) as { id: string; message: string; hostAgentId?: string };
			if (!pod) return new HttpResponse(null, { status: 404 });
			const conversation = {
				...storyPodChatFor(pod),
				id: "0199a3a0-0000-7000-8000-00000000c990",
				hostAgentId: body.hostAgentId ?? null,
				title: body.message.slice(0, 44),
			};
			return HttpResponse.json(
				{
					conversation,
					message: {
						id: body.id,
						threadId: storyPodChatFor(pod).id,
						author: testPerson({ id: storyUser.id, name: storyUser.name }),
						kind: "text",
						status: "complete",
						parts: [{ type: "text", text: body.message }],
						content: body.message,
						createdAt: new Date().toISOString(),
					},
				},
				{ status: 201 },
			);
		}),
		http.get(api("/conversations/:conversationId/history"), () =>
			HttpResponse.json({ items: [], nextCursor: null }),
		),
		http.get(api("/threads/:threadId/events"), quietStream),
		http.post(api("/threads/:threadId/typing"), () => new HttpResponse(null, { status: 204 })),
		http.get(api("/threads/:threadId/activity"), ({ params }) => {
			const bot = botForThread(String(params.threadId));
			return bot
				? HttpResponse.json(storyChatActivity(bot, messages[bot.id]))
				: new HttpResponse(null, { status: 404 });
		}),
		http.get(api("/threads/:threadId"), ({ params }) => {
			const pod = podForChat(String(params.threadId));
			if (pod) {
				return HttpResponse.json(storyPodChatDetails(pod, bots, data.podChatMessages?.[pod.id]));
			}
			const bot = botForThread(String(params.threadId));
			return bot
				? HttpResponse.json(storyChatDetails(bot, messages[bot.id]))
				: new HttpResponse(null, { status: 404 });
		}),
		http.get(api("/pods/:podId/connections"), () => HttpResponse.json([])),
		// No sandboxes in the example workspace, so the pod's Sandbox section stays hidden.
		http.get(api("/pods/:podId/sandbox"), () =>
			HttpResponse.json({ sandbox: { kind: "none" }, providerEnabled: false, canManage: false }),
		),
		http.get(api("/pods/:podId/members"), () =>
			HttpResponse.json([
				{
					userId: storyUser.id,
					name: storyUser.name,
					email: storyUser.email,
					image: null,
					addedAt: "2026-09-01T00:00:00.000Z",
					removable: false,
				},
			]),
		),
		http.get(api("/agents/:agentId/routines"), () => HttpResponse.json([])),
		http.get(api("/agents/:agentId/routines/:routineId/triggers/:triggerId/secret"), () =>
			HttpResponse.json({ kind: "set", secret: "whsec_Jx7KpQ2mVt9RbL4nYc8WfD3hGs6AzE1u" }),
		),
		http.get(api("/agents/:agentId/routines/:routineId/executions"), () =>
			HttpResponse.json({ items: [], nextCursor: null }),
		),
	];
}

/**
 * Answers a pod's connection reads from `connections` in full: the list with
 * counts, and one connection with its tools. Put them before `appHandlers`,
 * whose own answer is no connections.
 */
export function connectionHandlers(connections: readonly TestConnection[]): RequestHandler[] {
	const byId = (connectionId: unknown) => connections.find((one) => one.id === connectionId);
	return [
		http.get(api("/pods/:podId/connections"), () =>
			HttpResponse.json(connections.map(listedConnection)),
		),
		http.get(api("/pods/:podId/connections/:connectionId"), ({ params }) => {
			const found = byId(params.connectionId);
			return found
				? HttpResponse.json(connectionWithTools(found))
				: new HttpResponse(null, { status: 404 });
		}),
	];
}

/** The app at `path`, signed in as `storyUser`, with a cache of its own. */
export function StoryApp({ path, user = storyUser }: { path: string; user?: SessionUser }) {
	const [queryClient] = useState(() => createQueryClient());
	const [router] = useState(() =>
		createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	const session = { user, error: undefined, refresh: async () => {} };
	return (
		<QueryClientProvider client={queryClient}>
			<div className="h-screen">
				<AppRouterProvider router={router} session={session} />
			</div>
		</QueryClientProvider>
	);
}

/** Where a bot's chat is, under its pod. */
export function chatPath(bot: Agent): string {
	const pod = storyPods.find((one) => one.id === bot.podId);
	return `/${storyWorkspace.slug}/pods/${pod?.slug}/agents/${bot.handle}`;
}

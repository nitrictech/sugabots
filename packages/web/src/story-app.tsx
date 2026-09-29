import type {
	Agent,
	Chat,
	ChatListItem,
	Message,
	ModelProvider,
	Pod,
	SessionUser,
	SystemAgent,
	ThreadActivity,
	ThreadDetails,
	WorkspacePermissions,
	WorkspaceRole,
} from "@sugabots/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { HttpResponse, http, type RequestHandler } from "msw";
import { useEffect, useState } from "react";
import { createQueryClient } from "@/lib/query.ts";
import { createAppRouter } from "@/router.tsx";
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
};

/** Every pod, with the viewer as the Personal pod's owner, and every bot. */
export const storyPods: Pod[] = podsWithBots.map(({ pod }) =>
	pod.kind === "personal" ? { ...pod, ownerId: storyUser.id } : pod,
);
export const storyBots: Agent[] = podsWithBots.flatMap(({ bots }) => bots);

/** One chat per bot, by the bot's id, and its main thread. */
export function storyChatFor(agent: Agent): Chat {
	const suffix = agent.id.slice(-4);
	return {
		id: `0199a3a0-0000-7000-8000-00000000c${suffix.slice(1)}`,
		workspaceId: agent.workspaceId,
		podId: agent.podId,
		hostAgentId: agent.id,
		mainThreadId: `0199a3a0-0000-7000-8000-00000000d${suffix.slice(1)}`,
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

const systemAgents: SystemAgent[] = (["summarise", "facilitate"] as const).map((key) => ({
	key,
	name: key === "summarise" ? "Scribe" : "Facilitator",
	description: null,
	color: "ice",
	face: "pill",
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
	const chat = storyChatFor(agent);
	const bot = {
		kind: "agent" as const,
		id: agent.id,
		name: agent.name,
		handle: agent.handle,
		color: agent.color,
		face: agent.face,
	};
	const person = {
		kind: "person" as const,
		id: storyUser.id,
		name: storyUser.name,
		handle: "ryan-eyes",
		image: null,
	};
	return {
		thread: {
			id: chat.mainThreadId,
			workspaceId: agent.workspaceId,
			podId: agent.podId,
			hostAgentId: agent.id,
			chatId: chat.id,
			type: "chat",
			title: "Chat",
			status: "done",
			parentThreadId: null,
			initiatorUserId: storyUser.id,
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
		},
		capabilities: { approveToolCalls: true },
		routineExecution: null,
		participants: [person, bot],
		crew: [bot],
		olderMessagesCursor: null,
		messages,
	};
}

/** What a chat's sidebar shows: a summary, and who has written lately. */
export function storyChatActivity(agent: Agent, messages: Message[] = []): ThreadActivity {
	const chat = storyChatFor(agent);
	const details = storyChatDetails(agent, messages);
	return {
		summary: {
			content: `${agent.name} has been keeping things moving.`,
			sourceMessageId: messages.at(-1)?.id ?? chat.mainThreadId,
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
	providers?: ModelProvider[];
	models?: (typeof storyModel)[];
	onboarded?: boolean;
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
	const botForChat = (chatId: string) => bots.find((bot) => storyChatFor(bot).id === chatId);
	const botForThread = (threadId: string) =>
		bots.find((bot) => storyChatFor(bot).mainThreadId === threadId);

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
		http.get(api("/onboarding"), () => HttpResponse.json({ completed: data.onboarded ?? true })),
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
		http.get(api("/workspaces/:workspace/chats"), ({ request }) => {
			const pod = new URL(request.url).searchParams.get("pod");
			const shared = new Set(pods.filter((one) => one.kind === "shared").map((one) => one.id));
			const items: ChatListItem[] = bots
				.filter((bot) => (pod === "all" ? shared.has(bot.podId) : bot.podId === pod))
				.map((bot) => {
					const last = messages[bot.id]?.at(-1);
					return {
						agent: bot,
						chatId: last ? storyChatFor(bot).id : null,
						lastMessage: last
							? {
									preview: last.content,
									authorUserId: last.author.kind === "person" ? last.author.id : null,
									at: last.createdAt,
								}
							: null,
					};
				});
			return HttpResponse.json({ items });
		}),
		http.post(api("/workspaces/:workspace/chats"), async ({ request }) => {
			const body = (await request.json()) as { hostAgentId: string };
			const bot = botById(body.hostAgentId);
			return bot ? HttpResponse.json(storyChatFor(bot)) : new HttpResponse(null, { status: 404 });
		}),
		http.get(api("/chats/:chatId/messages"), ({ params }) => {
			const bot = botForChat(String(params.chatId));
			return HttpResponse.json({
				items: (bot ? (messages[bot.id] ?? []) : []).map((message) => ({
					kind: "message",
					message,
				})),
				nextCursor: null,
			});
		}),
		http.get(api("/chats/:chatId/history"), () =>
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
			const bot = botForThread(String(params.threadId));
			return bot
				? HttpResponse.json(storyChatDetails(bot, messages[bot.id]))
				: new HttpResponse(null, { status: 404 });
		}),
		http.get(api("/pods/:podId/connections"), () => HttpResponse.json([])),
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
	];
}

/** The app at `path`, signed in as `storyUser`, with a cache of its own. */
export function StoryApp({ path, user = storyUser }: { path: string; user?: SessionUser }) {
	const [queryClient] = useState(() => createQueryClient());
	const [router] = useState(() =>
		createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="h-screen">
				<RouterProvider
					router={router}
					context={{ session: { user, error: undefined, refresh: async () => {} } }}
				/>
			</div>
		</QueryClientProvider>
	);
}

/** Where a bot's chat is, under its pod. */
export function chatPath(bot: Agent): string {
	const pod = storyPods.find((one) => one.id === bot.podId);
	return `/${storyWorkspace.slug}/pods/${pod?.slug}/agents/${bot.handle}`;
}

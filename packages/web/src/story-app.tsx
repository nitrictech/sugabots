import {
	type Bot,
	botParticipantOf,
	type ChatMessageItem,
	type ConversationActivity,
	type ConversationDetails,
	type Message,
	type NotificationSettings,
	type Project,
	type ProjectThread,
	type SessionUser,
	type SystemBot,
	type WorkspacePermissions,
	type WorkspaceRole,
} from "@sugabots/contracts";
import {
	connectionWithTools,
	listedConnection,
	listedThread,
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
import { projectsWithBots, storyBots } from "@/shell/story-fixtures.ts";

/*
 * The whole app, for a story: the real routes at an address, answered by
 * `appHandlers` through the Storybook MSW worker. A story that shows a screen
 * as it appears in the app, with its sidebar and settings around it, uses
 * this rather than rendering the screen alone and guessing at its context.
 *
 * Fixtures are the design's example workspace, from `story-fixtures.ts`.
 */

const API = import.meta.env.VITE_API_URL as string;
const api = (path: string) => `${API}${path}`;

export const storyUser: SessionUser = {
	id: "0199a3a0-0000-7000-8000-000000000009",
	name: "Rowan Ellis",
	email: "rowan@example.com",
	image: null,
} as SessionUser;

const firstProject = projectsWithBots[0]?.project as Project;

export const storyWorkspace = {
	id: firstProject.workspaceId,
	name: "Nitric",
	slug: "nitric",
	timeZone: "UTC",
	setupCompletedAt: "2026-09-01T00:00:00.000Z",
};

/** Every project. */
export const storyProjects: Project[] = projectsWithBots.map(({ project }) => project);

/** The bots added to each project, by the project's id. */
const botsInProject = new Map(projectsWithBots.map(({ project, bots }) => [project.id, bots]));

/** One thread per bot, by the bot's id. */
export function storyThreadFor(bot: Bot): ProjectThread {
	const suffix = bot.id.slice(-4);
	return {
		kind: "project_thread",
		id: `0199a3a0-0000-7000-8000-00000000c${suffix.slice(1)}`,
		workspaceId: bot.workspaceId,
		projectId: bot.defaultProjectId,
		botId: bot.id,
		title: `Working with ${bot.name}`,
		archivedAt: null,
		doneAt: null,
		createdAt: "2026-09-18T06:00:00.000Z",
		updatedAt: "2026-09-18T06:10:00.000Z",
	};
}

/** Another thread with `bot`, apart from its first. */
export function storyConversationFor(bot: Bot): ProjectThread {
	const suffix = bot.id.slice(-4);
	return {
		...storyThreadFor(bot),
		id: `0199a3a0-0000-7000-8000-00000000d${suffix.slice(1)}`,
		title: `Conversation with ${bot.name}`,
	};
}

export const storyModel = {
	providerId: "0199a3a0-0000-7000-8000-000000000201",
	providerName: "Anthropic",
	providerPreset: "anthropic",
	modelId: "claude-sonnet-4-20250514",
	displayName: "Claude Sonnet",
	capabilities: ["tools", "vision", "reasoning"],
};

const systemBots: SystemBot[] = (["compact"] as const).map((key) => ({
	key,
	name: "Compaction",
	description: null,
	color: "ice",
	face: "pill",
	shape: "circle",
	model: storyModel.modelId,
}));

const NO_PERMISSIONS: WorkspacePermissions = {
	createProjects: false,
	createBots: false,
	updateWorkspace: false,
	manageProviders: false,
	manageMembers: false,
	configureBuiltInBots: false,
	manageUsage: false,
	manageAdmins: false,
	transferOwnership: false,
	deleteWorkspace: false,
};

/** What each role may do in the workspace, as the API's grant tables decide it. */
const PERMISSIONS_BY_ROLE: Record<WorkspaceRole, WorkspacePermissions> = {
	owner: {
		createProjects: true,
		createBots: true,
		updateWorkspace: true,
		manageProviders: true,
		manageMembers: true,
		configureBuiltInBots: true,
		manageUsage: true,
		manageAdmins: true,
		transferOwnership: true,
		deleteWorkspace: true,
	},
	admin: {
		createProjects: true,
		createBots: true,
		updateWorkspace: true,
		manageProviders: true,
		manageMembers: true,
		configureBuiltInBots: true,
		manageUsage: true,
		manageAdmins: false,
		transferOwnership: false,
		deleteWorkspace: false,
	},
	member: NO_PERMISSIONS,
	viewer: NO_PERMISSIONS,
};

/** What a bot's first thread holds: its messages, and who is in it. */
export function storyChatDetails(bot: Bot, messages: Message[] = []): ConversationDetails {
	const chat = storyThreadFor(bot);
	const participant = botParticipantOf(bot);
	const person = testPerson({ id: storyUser.id, name: storyUser.name });
	return {
		conversation: {
			id: chat.id,
			workspaceId: bot.workspaceId,
			projectId: chat.projectId,
			botId: bot.id,
			rootConversationId: chat.id,
			kind: "project_thread",
			title: chat.title,
			status: "done",
			parentConversationId: null,
			doneAt: null,
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
		},
		capabilities: { approveToolCalls: true },
		automationRun: null,
		participants: [person, participant],
		projectBots: [participant],
		// The bot is public, so everyone reaches its default project; the viewer stands for them.
		peopleReachingProject: [person],
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
		messages,
	};
}

/** A project's one thread in the stories, Planning, by the project's id. */
export function storyProjectThreadFor(project: Project): ProjectThread {
	return {
		kind: "project_thread",
		id: `0199a3a0-0000-7000-8000-00000000c9${project.id.slice(-2)}`,
		workspaceId: project.workspaceId,
		projectId: project.id,
		botId: null,
		title: "Planning",
		archivedAt: null,
		doneAt: null,
		createdAt: "2026-09-18T06:00:00.000Z",
		updatedAt: "2026-09-18T06:10:00.000Z",
	};
}

/** What a project's thread holds: its messages, and the project's people and bots to mention. */
export function storyProjectThreadDetails(
	project: Project,
	bots: readonly Bot[],
	messages: Message[] = [],
): ConversationDetails {
	const chat = storyProjectThreadFor(project);
	const person = testPerson({ id: storyUser.id, name: storyUser.name });
	return {
		conversation: {
			id: chat.id,
			workspaceId: chat.workspaceId,
			projectId: chat.projectId,
			botId: null,
			title: chat.title,
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
			rootConversationId: chat.id,
			kind: "project_thread",
			status: "done",
			parentConversationId: null,
			doneAt: null,
		},
		capabilities: { approveToolCalls: true },
		automationRun: null,
		participants: [person],
		projectBots: bots
			.filter((bot) => botsInProject.get(project.id)?.some((one) => one.id === bot.id))
			.map(botParticipantOf),
		peopleReachingProject: [person],
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
		messages,
	};
}

/** What a chat's sidebar shows: nothing measured yet. */
export const storyChatActivity: ConversationActivity = { context: null };

/** A stream that stays open and says nothing, as a quiet conversation's does. */
function quietStream() {
	return new HttpResponse(new ReadableStream({ start() {} }), {
		headers: { "content-type": "text/event-stream" },
	});
}

interface StoryAppData {
	role?: WorkspaceRole;
	projects?: Project[];
	bots?: Bot[];
	/** Messages in each bot's first thread, by the bot's id. */
	messages?: Record<string, Message[]>;
	/** Messages in each project's thread, by the project's id. */
	projectThreadMessages?: Record<string, Message[]>;
	models?: (typeof storyModel)[];
	/** The viewer's referral link, where the installation signs people up by referral. */
	referralLink?: string;
}

/** What the person chose to be notified about: nothing. */
const noNotificationChoices: NotificationSettings = {
	level: "mentions",
	pausedUntil: null,
	quietHours: null,
	turnFailures: true,
	automationRuns: "failures",
	projects: {},
	bots: {},
	mutedUntil: { projects: {}, bots: {} },
};

/**
 * The API as the app's example workspace answers it. Pass overrides for what
 * a story is about; put handlers of the story's own before these to answer
 * something else.
 */
export function appHandlers(data: StoryAppData = {}): RequestHandler[] {
	const projects = data.projects ?? storyProjects;
	const bots = data.bots ?? storyBots;
	const messages = data.messages ?? {};
	const botForConversation = (conversationId: string) =>
		bots.find((bot) => storyThreadFor(bot).id === conversationId);
	const projectForChat = (conversationId: string) =>
		projects.find((project) => storyProjectThreadFor(project).id === conversationId);

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
		http.get(api("/notifications"), () => HttpResponse.json(noNotificationChoices)),
		http.put(api("/notifications/presence"), () => new HttpResponse(null, { status: 204 })),
		http.put(
			api("/notifications/:kind/:id/:choice"),
			() => new HttpResponse(null, { status: 204 }),
		),
		http.get(api("/workspaces/:workspace/me"), () =>
			HttpResponse.json({
				role: data.role ?? "owner",
				permissions: PERMISSIONS_BY_ROLE[data.role ?? "owner"],
			}),
		),
		http.get(api("/workspaces/:workspace/projects"), () => HttpResponse.json(projects)),
		http.get(api("/workspaces/:workspace/bots"), () => HttpResponse.json(bots)),
		http.get(api("/workspaces/:workspace/model-providers/models"), () => {
			const models = data.models ?? [storyModel];
			return HttpResponse.json({ models, defaultModel: models[0]?.modelId ?? null });
		}),
		http.get(api("/workspaces/:workspace/model-providers"), () => HttpResponse.json([])),
		http.get(api("/workspaces/:workspace/system-bots"), () => HttpResponse.json(systemBots)),
		http.get(api("/workspaces/:workspace/search-provider"), () => HttpResponse.json(null)),
		http.get(api("/workspaces/:workspace/events"), quietStream),
		http.get(api("/me/events"), quietStream),
		http.get(api("/workspaces/:workspace/chats/inbox"), () => HttpResponse.json({ items: [] })),
		http.get(api("/workspaces/:workspace/chats/approvals"), () =>
			HttpResponse.json({ waiting: [], answered: [] }),
		),
		http.get(api("/workspaces/:workspace/chats/project-markers"), () =>
			HttpResponse.json({ projects: {} }),
		),
		http.get(api("/workspaces/:workspace/chats/attention"), () =>
			HttpResponse.json({
				unreadInInbox: 0,
				waitingApprovals: 0,
				unreadForYou: 0,
			}),
		),
		http.post(
			api("/conversations/:conversationId/read"),
			() => new HttpResponse(null, { status: 204 }),
		),
		http.post(api("/items/:conversationId/read"), () => new HttpResponse(null, { status: 204 })),
		http.get(api("/projects/:projectId/threads"), ({ params }) => {
			const projectId = String(params.projectId);
			const project = projects.find((one) => one.id === projectId);
			const bot = bots.find((one) => one.defaultProjectId === projectId);
			const thread = project
				? storyProjectThreadFor(project)
				: bot
					? storyThreadFor(bot)
					: undefined;
			if (!thread) return new HttpResponse(null, { status: 404 });
			return HttpResponse.json({ threads: [listedThread(thread)], automations: [] });
		}),
		http.get(api("/conversations/:conversationId/messages"), ({ params }) => {
			const bot = botForConversation(String(params.conversationId));
			const project = projectForChat(String(params.conversationId));
			const said = bot
				? messages[bot.id]
				: project
					? data.projectThreadMessages?.[project.id]
					: undefined;
			return HttpResponse.json({
				items: (said ?? [])
					.map((message): ChatMessageItem => ({ kind: "message", message }))
					.sort((left, right) => chatItemCreatedAt(left).localeCompare(chatItemCreatedAt(right))),
				nextCursor: null,
			});
		}),
		http.get(api("/conversations/:conversationId/history"), () =>
			HttpResponse.json({ items: [], nextCursor: null }),
		),
		http.get(api("/conversations/:conversationId/events"), quietStream),
		http.post(
			api("/conversations/:conversationId/typing"),
			() => new HttpResponse(null, { status: 204 }),
		),
		http.get(api("/conversations/:conversationId/activity"), ({ params }) => {
			const bot = botForConversation(String(params.conversationId));
			return bot ? HttpResponse.json(storyChatActivity) : new HttpResponse(null, { status: 404 });
		}),
		http.get(api("/conversations/:conversationId"), ({ params }) => {
			const project = projectForChat(String(params.conversationId));
			if (project) {
				return HttpResponse.json(
					storyProjectThreadDetails(project, bots, data.projectThreadMessages?.[project.id]),
				);
			}
			const bot = botForConversation(String(params.conversationId));
			return bot
				? HttpResponse.json(storyChatDetails(bot, messages[bot.id]))
				: new HttpResponse(null, { status: 404 });
		}),
		http.get(api("/projects/:projectId/bots"), ({ params }) => {
			const projectId = String(params.projectId);
			const inProject = botsInProject.get(projectId) ?? [];
			return HttpResponse.json(bots.filter((bot) => inProject.some((one) => one.id === bot.id)));
		}),
		http.get(api("/projects/:projectId/connections"), () => HttpResponse.json([])),
		// No computers in the example workspace.
		http.get(api("/projects/:projectId/computer"), () =>
			HttpResponse.json({ computer: { kind: "none" }, providerEnabled: false }),
		),
		// The viewer alone reaches each project, as its members list answers.
		http.get(api("/projects/:projectId/people"), () =>
			HttpResponse.json([testPerson({ id: storyUser.id, name: storyUser.name })]),
		),
		http.get(api("/projects/:projectId/members"), () =>
			HttpResponse.json([
				{
					userId: storyUser.id,
					name: storyUser.name,
					email: storyUser.email,
					image: null,
					removable: false,
				},
			]),
		),
		http.get(api("/projects/:projectId/automations"), () => HttpResponse.json([])),
		// No computers set up, unless a story says otherwise.
		http.get(api("/workspaces/:workspace/computer-providers/access"), () =>
			HttpResponse.json({ enabled: false }),
		),
		http.get(api("/projects/:projectId/automations/:automationId/triggers/:triggerId/secret"), () =>
			HttpResponse.json({ kind: "set", secret: "whsec_Jx7KpQ2mVt9RbL4nYc8WfD3hGs6AzE1u" }),
		),
		http.get(api("/projects/:projectId/runs"), () =>
			HttpResponse.json({ items: [], nextCursor: null }),
		),
	];
}

/**
 * Answers a bot's connection reads from `connections` in full: the list with
 * counts, and one connection with its tools. Put them before `appHandlers`,
 * whose own answer is no connections.
 */
export function connectionHandlers(connections: readonly TestConnection[]): RequestHandler[] {
	return [
		http.get(api("/projects/:projectId/connections"), ({ params }) =>
			HttpResponse.json(
				connections.filter((one) => one.projectId === params.projectId).map(listedConnection),
			),
		),
		http.get(api("/projects/:projectId/connections/:connectionId"), ({ params }) => {
			const found = connections.find(
				(one) => one.projectId === params.projectId && one.id === params.connectionId,
			);
			return found
				? HttpResponse.json(connectionWithTools(found))
				: new HttpResponse(null, { status: 404 });
		}),
	];
}

/** The app at `path`, signed in as `storyUser`, with a cache of its own. */
export function StoryApp({ path }: { path: string }) {
	const [queryClient] = useState(() => createQueryClient());
	const [router] = useState(() =>
		createAppRouter({
			history: createMemoryHistory({ initialEntries: [path] }),
			defaultViewTransition: false,
		}),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	const session = { user: storyUser, error: undefined, refresh: async () => {} };
	return (
		<QueryClientProvider client={queryClient}>
			<div className="h-screen">
				<AppRouterProvider router={router} session={session} />
			</div>
		</QueryClientProvider>
	);
}

/** Where a bot's first thread is. */
export function chatPath(bot: Bot): string {
	return `/${storyWorkspace.slug}/bots/${bot.handle}/threads/${storyThreadFor(bot).id}`;
}

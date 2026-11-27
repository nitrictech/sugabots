import {
	type Bot,
	botParticipantOf,
	type ChatDetails,
	type ChatMessageItem,
	type CurrentUser,
	type Message,
	type NotificationSettings,
	type Project,
	type ProjectChat,
	type SystemBot,
	type WorkspacePermissions,
	type WorkspaceRole,
} from "@sugabots/contracts";
import {
	connectorWithTools,
	listedChat,
	listedConnector,
	type TestConnector,
	testMember,
} from "@sugabots/contracts/testing";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, type RequestHandler } from "msw";
import { useEffect, useState } from "react";
import { chatItemCreatedAt } from "@/lib/chats.ts";
import { createQueryClient } from "@/lib/query.ts";
import { AppRouterProvider, createAppRouter } from "@/router.tsx";
import { projectsWithBots, storyBots } from "@/shell/story-fixtures.test-support.ts";

/*
 * The whole app, for a story: the real routes at an address, answered by
 * `appHandlers` through the Storybook MSW worker. A story that shows a screen
 * as it appears in the app, with its sidebar and settings around it, uses
 * this rather than rendering the screen alone and guessing at its context.
 *
 * Fixtures are the design's example workspace, from `story-fixtures.test-support.ts`.
 */

const API = import.meta.env.VITE_API_URL as string;
const api = (path: string) => `${API}${path}`;

export const storyMember: CurrentUser = {
	id: "0199a3a0-0000-7000-8000-000000000009",
	name: "Rowan Ellis",
	email: "rowan@example.com",
	image: null,
} as CurrentUser;

const firstProject = projectsWithBots[0]?.project as Project;

export const storyWorkspace = {
	id: firstProject.workspaceId,
	name: "Nitric",
	slug: "nitric",
	timeZone: "UTC",
	setUpAt: "2026-09-01T00:00:00.000Z",
};

/** Every project. */
export const storyProjects: Project[] = projectsWithBots.map(({ project }) => project);

/** The bots added to each project, by the project's id. */
const botsInProject = new Map(projectsWithBots.map(({ project, bots }) => [project.id, bots]));

/** One chat per bot, by the bot's id. */
export function storyChatFor(bot: Bot): ProjectChat {
	const suffix = bot.id.slice(-4);
	return {
		kind: "project_chat",
		id: `0199a3a0-0000-7000-8000-00000000c${suffix.slice(1)}`,
		workspaceId: bot.workspaceId,
		projectId: bot.defaultProjectId,
		botId: bot.id,
		title: `Working with ${bot.name}`,
		resolvedAt: null,
		createdAt: "2026-09-18T06:00:00.000Z",
		updatedAt: "2026-09-18T06:10:00.000Z",
	};
}

/** Another chat with `bot`, apart from its first. */
export function storySecondChatFor(bot: Bot): ProjectChat {
	const suffix = bot.id.slice(-4);
	return {
		...storyChatFor(bot),
		id: `0199a3a0-0000-7000-8000-00000000d${suffix.slice(1)}`,
		title: `Chat with ${bot.name}`,
	};
}

export const storyModel = {
	providerId: "0199a3a0-0000-7000-8000-000000000201",
	providerName: "Anthropic",
	providerBuiltIn: "anthropic",
	modelId: "claude-sonnet-4-20250514",
	displayName: "Claude Sonnet",
	capabilities: ["tools", "vision", "thinking"],
};

const systemBots: SystemBot[] = (["compact"] as const).map((key) => ({
	key,
	name: "Compaction",
	description: null,
	color: "ice",
	eyes: "pill",
	shape: "circle",
	model: storyModel.modelId,
}));

const NO_PERMISSIONS: WorkspacePermissions = {
	createProjects: false,
	createBots: false,
	updateWorkspace: false,
	manageProviders: false,
	manageMembers: false,
	chooseSystemModel: false,
	manageUsage: false,
	manageAdmins: false,
	handOverOwnership: false,
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
		chooseSystemModel: true,
		manageUsage: true,
		manageAdmins: true,
		handOverOwnership: true,
		deleteWorkspace: true,
	},
	admin: {
		createProjects: true,
		createBots: true,
		updateWorkspace: true,
		manageProviders: true,
		manageMembers: true,
		chooseSystemModel: true,
		manageUsage: true,
		manageAdmins: false,
		handOverOwnership: false,
		deleteWorkspace: false,
	},
	editor: NO_PERMISSIONS,
	viewer: NO_PERMISSIONS,
};

/** What a bot's first chat holds: its messages, and who is in it. */
export function storyChatDetails(bot: Bot, messages: Message[] = []): ChatDetails {
	const chat = storyChatFor(bot);
	const participant = botParticipantOf(bot);
	const member = testMember({ id: storyMember.id, name: storyMember.name });
	return {
		chat: {
			id: chat.id,
			workspaceId: bot.workspaceId,
			projectId: chat.projectId,
			botId: bot.id,
			rootChatId: chat.id,
			kind: "project_chat",
			title: chat.title,
			working: false,
			resolvedAt: null,
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
		},
		permissions: {
			approveToolCallsIn: messages.map((message) => message.id),
			approveComputerRequests: true,
			interruptTurns: [],
		},
		automationRun: null,
		participants: [member, participant],
		projectBots: [participant],
		// The bot is public, so everyone reaches its default project; the viewer stands for them.
		membersReachingProject: [member],
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
		messages,
	};
}

/**
 * A finished message by the viewer or a bot, in the chat with `chatId`. `id` is
 * two hex digits, which end the message's id.
 */
export function storyMessage({
	id,
	chatId,
	by,
	text,
	at,
}: {
	id: string;
	chatId: string;
	by: Bot | "you";
	text: string;
	at: string;
}): Message {
	return {
		id: `0199a3a0-0000-7000-8000-0000000005${id}`,
		chatId,
		author:
			by === "you"
				? testMember({ id: storyMember.id, name: storyMember.name })
				: {
						kind: "bot",
						id: by.id,
						name: by.name,
						handle: by.handle,
						color: by.color,
						eyes: by.eyes,
						shape: by.shape,
					},
		status: "complete",
		parts: [{ type: "text", text }],
		content: text,
		createdAt: at,
	};
}

/** A project's one chat in the stories, Planning, by the project's id. */
export function storyProjectChatFor(project: Project): ProjectChat {
	return {
		kind: "project_chat",
		id: `0199a3a0-0000-7000-8000-00000000c9${project.id.slice(-2)}`,
		workspaceId: project.workspaceId,
		projectId: project.id,
		botId: null,
		title: "Planning",
		resolvedAt: null,
		createdAt: "2026-09-18T06:00:00.000Z",
		updatedAt: "2026-09-18T06:10:00.000Z",
	};
}

/** What a project's chat holds: its messages, and the project's members and bots to mention. */
export function storyProjectChatDetails(
	project: Project,
	bots: readonly Bot[],
	messages: Message[] = [],
): ChatDetails {
	const chat = storyProjectChatFor(project);
	const member = testMember({ id: storyMember.id, name: storyMember.name });
	return {
		chat: {
			id: chat.id,
			workspaceId: chat.workspaceId,
			projectId: chat.projectId,
			botId: null,
			title: chat.title,
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
			rootChatId: chat.id,
			kind: "project_chat",
			working: false,
			resolvedAt: null,
		},
		permissions: {
			approveToolCallsIn: messages.map((message) => message.id),
			approveComputerRequests: true,
			interruptTurns: [],
		},
		automationRun: null,
		participants: [member],
		projectBots: bots
			.filter((bot) => botsInProject.get(project.id)?.some((one) => one.id === bot.id))
			.map(botParticipantOf),
		membersReachingProject: [member],
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
		messages,
	};
}

/** A stream that stays open and says nothing, as a quiet chat's does. */
function quietStream() {
	return new HttpResponse(new ReadableStream({ start() {} }), {
		headers: { "content-type": "text/event-stream" },
	});
}

interface StoryAppData {
	role?: WorkspaceRole;
	projects?: Project[];
	bots?: Bot[];
	/** Messages in each bot's first chat, by the bot's id. */
	messages?: Record<string, Message[]>;
	/** Messages in each project's chat, by the project's id. */
	projectChatMessages?: Record<string, Message[]>;
	models?: (typeof storyModel)[];
	/** The viewer's referral link, where the server signs members up by referral. */
	referralLink?: string;
}

/** What the member chose to be notified about: nothing. */
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
	const botForChat = (chatId: string) => bots.find((bot) => storyChatFor(bot).id === chatId);
	const projectForChat = (chatId: string) =>
		projects.find((project) => storyProjectChatFor(project).id === chatId);

	return [
		http.get(api("/workspaces"), () => HttpResponse.json([storyWorkspace])),
		http.get(api("/workspaces/:workspace/memberships"), () =>
			HttpResponse.json([
				{
					id: "0199a3a0-0000-7000-8000-0000000000d1",
					role: data.role ?? "owner",
					member: storyMember,
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
		http.get(api("/workspaces/:workspace/chats/approvals"), () =>
			HttpResponse.json({ waiting: [], answered: [] }),
		),
		http.get(api("/workspaces/:workspace/chats/attention-marks"), () =>
			HttpResponse.json({ projects: {} }),
		),
		http.get(api("/workspaces/:workspace/chats/attention"), () =>
			HttpResponse.json({
				waitingApprovals: 0,
				unreadForYou: 0,
			}),
		),
		http.post(api("/chats/:chatId/read"), () => new HttpResponse(null, { status: 204 })),
		http.post(api("/nested-chats/:chatId/read"), () => new HttpResponse(null, { status: 204 })),
		http.get(api("/projects/:projectId/chats"), ({ params }) => {
			const projectId = String(params.projectId);
			const project = projects.find((one) => one.id === projectId);
			const bot = bots.find((one) => one.defaultProjectId === projectId);
			const chat = project ? storyProjectChatFor(project) : bot ? storyChatFor(bot) : undefined;
			if (!chat) return new HttpResponse(null, { status: 404 });
			return HttpResponse.json({ chats: [listedChat(chat)], automations: [] });
		}),
		http.get(api("/chats/:chatId/messages"), ({ params }) => {
			const bot = botForChat(String(params.chatId));
			const project = projectForChat(String(params.chatId));
			const said = bot
				? messages[bot.id]
				: project
					? data.projectChatMessages?.[project.id]
					: undefined;
			return HttpResponse.json({
				items: (said ?? [])
					.map((message): ChatMessageItem => ({ kind: "message", message }))
					.sort((left, right) => chatItemCreatedAt(left).localeCompare(chatItemCreatedAt(right))),
				nextCursor: null,
			});
		}),
		http.get(api("/chats/:chatId/events"), quietStream),
		http.post(api("/chats/:chatId/typing"), () => new HttpResponse(null, { status: 204 })),
		// Nothing in a story's chats has been measured yet.
		http.get(api("/chats/:chatId/context"), ({ params }) => {
			const bot = botForChat(String(params.chatId));
			return bot ? HttpResponse.json(null) : new HttpResponse(null, { status: 404 });
		}),
		http.get(api("/chats/:chatId"), ({ params }) => {
			const project = projectForChat(String(params.chatId));
			if (project) {
				return HttpResponse.json(
					storyProjectChatDetails(project, bots, data.projectChatMessages?.[project.id]),
				);
			}
			const bot = botForChat(String(params.chatId));
			return bot
				? HttpResponse.json(storyChatDetails(bot, messages[bot.id]))
				: new HttpResponse(null, { status: 404 });
		}),
		http.get(api("/projects/:projectId/bots"), ({ params }) => {
			const projectId = String(params.projectId);
			const inProject = botsInProject.get(projectId) ?? [];
			return HttpResponse.json(bots.filter((bot) => inProject.some((one) => one.id === bot.id)));
		}),
		http.get(api("/projects/:projectId/connectors"), () => HttpResponse.json([])),
		http.get(api("/projects/:projectId/bot-connectors"), () => HttpResponse.json([])),
		// No computers in the example workspace.
		http.get(api("/projects/:projectId/computer"), () =>
			HttpResponse.json({ computer: { kind: "none" }, providerEnabled: false }),
		),
		// The viewer alone reaches each project, as its members list answers.
		http.get(api("/projects/:projectId/members-reaching"), () =>
			HttpResponse.json([testMember({ id: storyMember.id, name: storyMember.name })]),
		),
		http.get(api("/projects/:projectId/members"), () =>
			HttpResponse.json([
				{
					memberId: storyMember.id,
					name: storyMember.name,
					email: storyMember.email,
					image: null,
					removable: false,
				},
			]),
		),
		// The viewer alone is a member of each private bot.
		http.get(api("/bots/:botId/members"), () =>
			HttpResponse.json([
				{
					memberId: storyMember.id,
					name: storyMember.name,
					email: storyMember.email,
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
 * Answers a bot's connector reads from `connectors` in full: the list with
 * counts, and one connector with its tools. Put them before `appHandlers`,
 * whose own answer is no connectors.
 */
export function connectorHandlers(connectors: readonly TestConnector[]): RequestHandler[] {
	return [
		http.get(api("/projects/:projectId/connectors"), ({ params }) =>
			HttpResponse.json(
				connectors.filter((one) => one.projectId === params.projectId).map(listedConnector),
			),
		),
		http.get(api("/projects/:projectId/connectors/:connectorId"), ({ params }) => {
			const found = connectors.find(
				(one) => one.projectId === params.projectId && one.id === params.connectorId,
			);
			return found
				? HttpResponse.json(connectorWithTools(found))
				: new HttpResponse(null, { status: 404 });
		}),
	];
}

/** The app at `path`, signed in as `storyMember`, with a cache of its own. */
export function StoryApp({ path }: { path: string }) {
	const [queryClient] = useState(() => createQueryClient());
	const [router] = useState(() =>
		createAppRouter({
			history: createMemoryHistory({ initialEntries: [path] }),
			defaultViewTransition: false,
		}),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	const session = { member: storyMember, error: undefined, refresh: async () => {} };
	return (
		<QueryClientProvider client={queryClient}>
			<div className="h-screen">
				<AppRouterProvider router={router} session={session} />
			</div>
		</QueryClientProvider>
	);
}

/** Where a bot's first chat is. */
export function chatPath(bot: Bot): string {
	return `/${storyWorkspace.slug}/bots/${bot.handle}/chats/${storyChatFor(bot).id}`;
}

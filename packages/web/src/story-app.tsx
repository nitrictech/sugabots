import type {
	Bot,
	ChatMessageItem,
	ConversationActivity,
	ConversationDetails,
	DirectMessageListItem,
	ListedThread,
	Message,
	ModelProvider,
	NotificationSettings,
	Project,
	ProjectThread,
	SessionUser,
	SystemBot,
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
import { storyBots as fixtureBots, projectsWithBots } from "@/shell/story-fixtures.ts";

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

/** Every project, and every bot. */
export const storyProjects: Project[] = projectsWithBots.map(({ project }) => project);
export const storyBots: Bot[] = [...fixtureBots];

/** The bots added to each project, by the project's id. */
const botsInProject = new Map(projectsWithBots.map(({ project, bots }) => [project.id, bots]));

/** The id of a bot's default project in the stories, where its threads are. */
function storyDefaultProjectOf(bot: Bot): string {
	return `0199a3a0-0000-7000-8000-00000000d${bot.id.slice(-3)}`;
}

/** One thread per bot, by the bot's id. */
export function storyThreadFor(bot: Bot): ProjectThread {
	const suffix = bot.id.slice(-4);
	return {
		kind: "project_thread",
		id: `0199a3a0-0000-7000-8000-00000000c${suffix.slice(1)}`,
		workspaceId: bot.workspaceId,
		projectId: storyDefaultProjectOf(bot),
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

/** A project's thread as its list shows it, with nothing new in it. */
export function storyListedThread(thread: ProjectThread): ListedThread {
	return {
		conversation: thread,
		lastMessage: null,
		participants: [],
		messageCount: 1,
		waitingOn: null,
		unreadMessages: 0,
		needsApproval: false,
		mentionsYou: false,
	};
}

export const storyModel = {
	providerId: "0199a3a0-0000-7000-8000-000000000201",
	providerName: "Anthropic",
	providerPreset: "anthropic",
	providerActive: true,
	modelId: "claude-sonnet-4-20250514",
	displayName: "Claude Sonnet",
	capabilities: ["tools", "vision", "reasoning"],
};

const systemBots: SystemBot[] = (["summarise", "compact"] as const).map((key) => ({
	key,
	name: key === "summarise" ? "Summariser" : "Compaction",
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
	const participant = {
		kind: "bot" as const,
		id: bot.id,
		name: bot.name,
		handle: bot.handle,
		color: bot.color,
		face: bot.face,
		shape: bot.shape,
	};
	const person = testPerson({ id: storyUser.id, name: storyUser.name });
	return {
		conversation: {
			id: chat.id,
			workspaceId: bot.workspaceId,
			projectId: storyDefaultProjectOf(bot),
			botId: bot.id,
			rootConversationId: chat.id,
			kind: "project_thread",
			title: chat.title,
			status: "done",
			parentConversationId: null,
			startedById: storyUser.id,
			doneAt: null,
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
		},
		capabilities: { approveToolCalls: true },
		automationRun: null,
		participants: [person, participant],
		projectBots: [participant],
		members: [],
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
	bots: Bot[],
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
			startedById: storyUser.id,
			doneAt: null,
		},
		capabilities: { approveToolCalls: true },
		automationRun: null,
		participants: [person],
		projectBots: bots
			.filter((bot) => botsInProject.get(project.id)?.some((one) => one.id === bot.id))
			.map((bot) => ({
				kind: "bot" as const,
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

/** What a chat's sidebar shows: a summary. */
export function storyChatActivity(bot: Bot, messages: Message[] = []): ConversationActivity {
	const chat = storyThreadFor(bot);
	return {
		summary: {
			content: `${bot.name} has been keeping things moving.`,
			sourceMessageId: messages.at(-1)?.id ?? chat.id,
			updatedAt: chat.updatedAt,
		},
		context: null,
	};
}

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
	providers?: ModelProvider[];
	models?: (typeof storyModel)[];
	/** The viewer's referral link, where the installation signs people up by referral. */
	referralLink?: string;
	/** What the person chose to be notified about; nothing chosen when absent. */
	notifications?: NotificationSettings;
	/** The viewer's direct messages, most recent first; none when absent. */
	directMessages?: DirectMessageListItem[];
	/** Messages in each direct message, by its conversation's id. */
	directMessageMessages?: Record<string, Message[]>;
	/** Everybody in the workspace besides the viewer. */
	otherMembers?: SessionUser[];
}

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
	const botById = (id: string) => bots.find((bot) => bot.id === id);
	const botForConversation = (conversationId: string) =>
		bots.find((bot) => storyThreadFor(bot).id === conversationId);
	const projectForChat = (conversationId: string) =>
		projects.find((project) => storyProjectThreadFor(project).id === conversationId);
	const directMessages = data.directMessages ?? [];
	// A copy, so what a story sends stays in that story.
	const directMessageMessages = { ...data.directMessageMessages };
	const directMessageOf = (conversationId: string) =>
		directMessages.find((item) => item.conversation.id === conversationId);

	return [
		...directMessageHandlers(directMessages, directMessageMessages),
		http.get(api("/conversations/:conversationId"), ({ params }) => {
			const item = directMessageOf(String(params.conversationId));
			if (!item) return undefined;
			return HttpResponse.json(
				storyDirectMessageDetails(item, directMessageMessages[item.conversation.id]),
			);
		}),
		http.get(api("/workspaces"), () => HttpResponse.json([storyWorkspace])),
		http.get(api("/workspaces/:workspace/members"), () =>
			HttpResponse.json([
				{
					id: "0199a3a0-0000-7000-8000-0000000000d1",
					role: data.role ?? "owner",
					user: storyUser,
					joinedAt: "2026-09-01T00:00:00.000Z",
				},
				...(data.otherMembers ?? []).map((user, index) => ({
					id: `0199a3a0-0000-7000-8000-0000000000e${index}`,
					role: "member",
					user,
					joinedAt: "2026-09-02T00:00:00.000Z",
				})),
			]),
		),
		http.get(api("/workspaces/:workspace/invitations"), () => HttpResponse.json([])),
		http.get(api("/referral-link"), () => HttpResponse.json({ url: data.referralLink ?? null })),
		http.get(api("/notifications"), () =>
			HttpResponse.json(data.notifications ?? noNotificationChoices),
		),
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
		http.get(api("/workspaces/:workspace/model-providers"), () =>
			HttpResponse.json(data.providers ?? []),
		),
		http.get(api("/workspaces/:workspace/system-bots"), () => HttpResponse.json(systemBots)),
		http.get(api("/workspaces/:workspace/automations"), () => HttpResponse.json({ items: [] })),
		http.get(api("/workspaces/:workspace/search-provider"), () => HttpResponse.json(null)),
		http.get(api("/workspaces/:workspace/events"), quietStream),
		http.get(api("/me/events"), quietStream),
		http.get(api("/workspaces/:workspace/chats/inbox"), () => HttpResponse.json({ items: [] })),
		http.get(api("/workspaces/:workspace/chats/approvals"), () =>
			HttpResponse.json({ waiting: [], answered: [] }),
		),
		http.get(api("/workspaces/:workspace/chats/project-markers"), () =>
			HttpResponse.json({ projects: {}, bots: {} }),
		),
		http.post(
			api("/conversations/:conversationId/read"),
			() => new HttpResponse(null, { status: 204 }),
		),
		http.post(api("/items/:conversationId/read"), () => new HttpResponse(null, { status: 204 })),
		http.get(api("/workspaces/:workspace/chats"), ({ request }) => {
			// By the project's id or its slug, as the API takes it.
			const named = new URL(request.url).searchParams.get("project");
			const project = projects.find((one) => one.id === named || one.slug === named);
			return HttpResponse.json({
				chats: project ? [storyListedThread(storyProjectThreadFor(project))] : [],
			});
		}),
		http.get(api("/bots/:botId/threads"), ({ params }) => {
			const bot = botById(String(params.botId));
			if (!bot) return new HttpResponse(null, { status: 404 });
			return HttpResponse.json({
				bot,
				threads: [storyListedThread(storyThreadFor(bot))],
				automations: [],
				summary: null,
			});
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
			return bot
				? HttpResponse.json(storyChatActivity(bot, messages[bot.id]))
				: new HttpResponse(null, { status: 404 });
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
		http.get(api("/projects/:projectId/connections"), () => HttpResponse.json([])),
		// No computers in the example workspace, so the bot's Computer section stays hidden.
		http.get(api("/projects/:projectId/computer"), () =>
			HttpResponse.json({ computer: { kind: "none" }, providerEnabled: false, canManage: false }),
		),
		http.get(api("/projects/:projectId/members"), () =>
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
		http.get(api("/projects/:projectId/automations"), () => HttpResponse.json([])),
		// No computers set up, unless a story says otherwise.
		http.get(api("/workspaces/:workspace/computer-providers/access"), () =>
			HttpResponse.json({ enabled: false }),
		),
		http.get(api("/projects/:projectId/automations/:automationId/triggers/:triggerId/secret"), () =>
			HttpResponse.json({ kind: "set", secret: "whsec_Jx7KpQ2mVt9RbL4nYc8WfD3hGs6AzE1u" }),
		),
		http.get(api("/projects/:projectId/automations/:automationId/runs"), () =>
			HttpResponse.json({ items: [], nextCursor: null }),
		),
	];
}

/**
 * The API's answers about the viewer's direct messages: the list of them,
 * each one, sending to people they have one with, and the messages in each.
 */
function directMessageHandlers(
	items: readonly DirectMessageListItem[],
	messages: Record<string, Message[]>,
): RequestHandler[] {
	/** Keeps `content`, the viewer's, as the newest message in the direct message `id`. */
	const post = (id: string, messageId: string, content: string): Message => {
		const sent: Message = {
			id: messageId,
			conversationId: id,
			author: testPerson({ id: storyUser.id, name: storyUser.name, email: storyUser.email }),
			kind: "text",
			status: "complete",
			parts: [{ type: "text", text: content }],
			content,
			createdAt: new Date().toISOString(),
		};
		messages[id] = [...(messages[id] ?? []), sent];
		return sent;
	};
	return [
		http.get(api("/workspaces/:workspace/direct-messages"), () => HttpResponse.json({ items })),
		http.get(api("/direct-messages/:conversationId"), ({ params }) => {
			const found = items.find((item) => item.conversation.id === params.conversationId);
			return found ? HttpResponse.json(found) : new HttpResponse(null, { status: 404 });
		}),
		// Only to people the viewer already has one with: the stories make no new ones.
		http.post(api("/workspaces/:workspace/direct-messages"), async ({ request }) => {
			const body = (await request.json()) as { userIds: string[]; id: string; message: string };
			const wanted = new Set(body.userIds);
			const found = items.find(
				(item) =>
					item.formerMembers === 0 &&
					item.people.length === wanted.size &&
					item.people.every((person) => wanted.has(person.id)),
			);
			if (!found) return new HttpResponse(null, { status: 404 });
			const message = post(found.conversation.id, body.id, body.message);
			return HttpResponse.json({ conversation: found.conversation, message }, { status: 201 });
		}),
		http.post(api("/conversations/:conversationId/messages"), async ({ params, request }) => {
			const id = String(params.conversationId);
			if (!items.some((item) => item.conversation.id === id)) return undefined;
			const body = (await request.json()) as { id: string; message: string };
			return HttpResponse.json(post(id, body.id, body.message), { status: 201 });
		}),
		http.get(api("/conversations/:conversationId/messages"), ({ params }) => {
			const id = String(params.conversationId);
			if (!items.some((item) => item.conversation.id === id)) return undefined;
			return HttpResponse.json({
				items: (messages[id] ?? []).map(
					(message): ChatMessageItem => ({ kind: "message", message }),
				),
				nextCursor: null,
			});
		}),
	];
}

/** What a direct message holds: its messages, and the viewer and whom it is with. */
function storyDirectMessageDetails(
	item: DirectMessageListItem,
	messages: Message[] = [],
): ConversationDetails {
	const viewer = testPerson({ id: storyUser.id, name: storyUser.name });
	const people = [viewer, ...item.people];
	const { conversation } = item;
	return {
		conversation: {
			id: conversation.id,
			workspaceId: conversation.workspaceId,
			projectId: null,
			botId: null,
			rootConversationId: conversation.id,
			kind: conversation.kind,
			title: conversation.title,
			status: "done",
			parentConversationId: null,
			startedById: storyUser.id,
			doneAt: null,
			createdAt: conversation.createdAt,
			updatedAt: conversation.updatedAt,
		},
		capabilities: { approveToolCalls: true },
		automationRun: null,
		participants: people,
		projectBots: [],
		members: people,
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
		messages,
	};
}

/**
 * Answers a bot's connection reads from `connections` in full: the list with
 * counts, and one connection with its tools. Put them before `appHandlers`,
 * whose own answer is no connections.
 */
export function connectionHandlers(connections: readonly TestConnection[]): RequestHandler[] {
	const byId = (connectionId: unknown) => connections.find((one) => one.id === connectionId);
	return [
		http.get(api("/projects/:projectId/connections"), () =>
			HttpResponse.json(connections.map(listedConnection)),
		),
		http.get(api("/projects/:projectId/connections/:connectionId"), ({ params }) => {
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
		createAppRouter({
			history: createMemoryHistory({ initialEntries: [path] }),
			defaultViewTransition: false,
		}),
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

/** Where a bot's first thread is. */
export function chatPath(bot: Bot): string {
	return `/${storyWorkspace.slug}/bots/${bot.handle}/threads/${storyThreadFor(bot).id}`;
}

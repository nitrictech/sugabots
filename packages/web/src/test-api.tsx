import {
	administersWorkspace,
	type Bot,
	type BotPermissions,
	type ConversationDetails,
	type ListedThread,
	type ModelProvider,
	type Project,
	type ProjectPermissions,
	type ProjectThread,
	type SessionUser,
	type StreamEvent,
	type SystemBot,
	type WorkspaceRole,
} from "@sugabots/contracts";
import { NotFound } from "@sugabots/contracts/http";
import {
	connectionWithTools,
	listedConnection,
	type TestConnection,
} from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { fireEvent, render } from "@testing-library/react";
import { Effect } from "effect";
import { onTestFinished, vi } from "vitest";
import { SIDE_BY_SIDE } from "@/lib/media.ts";
import { createQueryClient } from "@/lib/query.ts";
import type { Session } from "@/lib/session.ts";
import { AppRouterProvider, createAppRouter } from "@/router.tsx";
import { client } from "@/test-client.ts";
import { TooltipProvider } from "@/ui/tooltip.tsx";

/**
 * The seam every web test mounts against: a fake `@/api.ts`, the real route
 * tree over a memory history, and the fixtures the dev seed makes.
 *
 * It lives outside the test files because two of them need the same fixtures
 * and the same mock object. A test file opts in with one line:
 *
 * ```ts
 * vi.mock("@/api.ts", () => import("@/test-client.ts"));
 * ```
 *
 * — note that it is `test-client.ts` and not this file that stands in for the
 * API. This one imports the router, and the router imports `@/api.ts`, so
 * mocking with *this* module would make the mock load the thing it replaces.
 *
 * The API is reached through `@/api.ts` and nothing else, which is what makes
 * one seam enough. Guards and search params are exercised rather than mocked
 * around, because the router is the real one.
 */

export const sam: SessionUser = {
	id: "0199a3a0-0000-7000-8000-000000000009",
	email: "sam@example.com",
	name: "Sam",
	image: null,
};

/** A second person in the workspace, so the roster has somebody who is not you. */
export const juno: SessionUser = {
	id: "0199a3a0-0000-7000-8000-00000000000a",
	email: "juno@example.com",
	name: "Juno",
	image: null,
};

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";

export const workspace = {
	id: WORKSPACE,
	name: "Suga Workspace",
	slug: "suga",
	timeZone: "UTC",
	setupCompletedAt: "2026-09-01T00:00:00.000Z",
};

/** Every project permission, as an admin gets them. */
const ADMIN_IN_PROJECT: ProjectPermissions = {
	rename: true,
	manageMembers: true,
	manageBots: true,
	leave: false,
	join: false,
	delete: true,
	deleteFiles: true,
	manageConnections: true,
	manageComputer: true,
	useDesktop: true,
	manageAutomations: true,
	runAutomations: true,
};

/** What a member gets in a project they are in. */
const MEMBER_IN_PROJECT: ProjectPermissions = {
	...ADMIN_IN_PROJECT,
	rename: false,
	leave: true,
	delete: false,
	deleteFiles: false,
	manageConnections: false,
	manageComputer: false,
	manageAutomations: false,
};

/** What a viewer gets there: nothing they could change. */
const VIEWER_IN_PROJECT: ProjectPermissions = {
	...MEMBER_IN_PROJECT,
	manageMembers: false,
	manageBots: false,
};

/** Every bot permission, as its creator or an administrator gets them. */
const MANAGER_OF_BOT: BotPermissions = {
	update: true,
	delete: true,
	manageConnections: true,
	manageComputer: true,
	useDesktop: true,
	manageAutomations: true,
	runAutomations: true,
	talk: true,
};

/** What anyone else in the workspace gets with a public bot: talking to it, and running its automations. */
const USER_OF_BOT: BotPermissions = {
	...MANAGER_OF_BOT,
	update: false,
	delete: false,
	manageConnections: false,
	manageComputer: false,
	manageAutomations: false,
};

/** The two projects the dev seed makes. */
export const projects: Project[] = [
	{
		id: "0199a3a0-0000-7000-8000-0000000000a1",
		workspaceId: WORKSPACE,
		name: "Suga-Team",
		slug: "suga-team",
		color: "green",
		description: null,
		visibility: "public",
		// Customer Research, which the bots below list first.
		leadBotId: "0199a3a0-0000-7000-8000-0000000000b1",
		isMember: true,
		permissions: ADMIN_IN_PROJECT,
		createdAt: "2026-09-09T00:00:00.000Z",
	},
	{
		id: "0199a3a0-0000-7000-8000-0000000000a2",
		workspaceId: WORKSPACE,
		name: "Sales",
		slug: "sales",
		color: "blue",
		description: null,
		visibility: "public",
		// Customer Research, which the bots below list first.
		leadBotId: "0199a3a0-0000-7000-8000-0000000000b1",
		isMember: true,
		permissions: ADMIN_IN_PROJECT,
		createdAt: "2026-09-09T00:00:00.000Z",
	},
];

export const MODELS = ["claude-opus-4-1-20250805", "claude-sonnet-4-20250514"];

export const modelProviders: ModelProvider[] = [
	{
		id: "0199a3a0-0000-7000-8000-0000000000c1",
		workspaceId: WORKSPACE,
		preset: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		apiFormat: "openai",
		active: true,
		status: "connected",
		hasApiKey: true,
		signedIn: false,
		customHeaders: [],
		modelCount: 1,
		enabledModelCount: 1,
		lastTestedAt: "2026-09-11T00:00:00.000Z",
		lastTestError: null,
		connectedBy: null,
		createdAt: "2026-09-09T00:00:00.000Z",
		models: [
			{
				id: "0199a3a0-0000-7000-8000-0000000000d1",
				modelId: "gpt-5",
				displayName: null,
				capabilities: ["tools", "vision", "images"],
				disabledCapabilities: [],
				contextLength: null,
				enabled: true,
				source: "fetched",
			},
		],
	},
	{
		id: "0199a3a0-0000-7000-8000-0000000000c2",
		workspaceId: WORKSPACE,
		preset: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		apiFormat: "anthropic",
		active: true,
		status: "connected",
		hasApiKey: true,
		signedIn: false,
		customHeaders: [],
		modelCount: 1,
		enabledModelCount: 1,
		lastTestedAt: "2026-09-11T00:00:00.000Z",
		lastTestError: null,
		connectedBy: null,
		createdAt: "2026-09-09T00:00:00.000Z",
		models: [
			{
				id: "0199a3a0-0000-7000-8000-0000000000d2",
				modelId: "claude-opus-4-1-20250805",
				displayName: null,
				capabilities: ["tools", "vision"],
				disabledCapabilities: [],
				contextLength: null,
				enabled: true,
				source: "fetched",
			},
		],
	},
];

export const bots: Bot[] = [
	{
		id: "0199a3a0-0000-7000-8000-0000000000b1",
		workspaceId: WORKSPACE,
		defaultProjectId: "0199a3a0-0000-7000-8000-0000000002b1",
		name: "Customer Research",
		handle: "customer-research",
		description: "Digs through calls and notes for what customers asked for.",
		color: "purple",
		face: "dot",
		shape: "circle",
		model: MODELS[1] as string,
		prompt: "",
		disabledTools: [],
		usesComputer: false,
		naturalBrowsing: false,
		createdById: null,
		visibility: "public",
		assistant: false,
		pinned: true,
		permissions: MANAGER_OF_BOT,
		createdAt: "2026-09-10T00:00:00.000Z",
	},
	{
		id: "0199a3a0-0000-7000-8000-0000000000b2",
		workspaceId: WORKSPACE,
		defaultProjectId: "0199a3a0-0000-7000-8000-0000000002b2",
		name: "Issue Triager",
		handle: "issue-triager",
		description: "Sorts incoming issues every weekday morning.",
		color: "green",
		face: "arc",
		shape: "circle",
		model: MODELS[0] as string,
		prompt: "",
		disabledTools: [],
		usesComputer: false,
		naturalBrowsing: false,
		createdById: null,
		visibility: "public",
		assistant: false,
		pinned: true,
		permissions: MANAGER_OF_BOT,
		createdAt: "2026-09-10T00:00:00.000Z",
	},
	{
		id: "0199a3a0-0000-7000-8000-0000000000b3",
		workspaceId: WORKSPACE,
		defaultProjectId: "0199a3a0-0000-7000-8000-0000000002b3",
		name: "Linear Handler",
		handle: "linear-handler",
		description: "Reads and writes Linear on the team's behalf.",
		color: "sky",
		face: "pill",
		shape: "circle",
		model: MODELS[0] as string,
		prompt: "Be brief.",
		disabledTools: [],
		usesComputer: false,
		naturalBrowsing: false,
		createdById: sam.id,
		visibility: "public",
		assistant: false,
		pinned: true,
		permissions: MANAGER_OF_BOT,
		createdAt: "2026-09-10T00:00:00.000Z",
	},
];

export const linear = bots[2] as Bot;
export const triager = bots[1] as Bot;

/** Sam's Personal Assistant, which the default `bots` answer includes. */
export const personalAssistant: Bot = {
	id: "0199a3a0-0000-7000-8000-0000000000bf",
	workspaceId: WORKSPACE,
	defaultProjectId: "0199a3a0-0000-7000-8000-0000000002bf",
	name: "Personal Assistant",
	handle: "personal-assistant",
	description: "Your private assistant.",
	color: "green",
	face: "pill",
	shape: "circle",
	model: MODELS[1] as string,
	prompt: "",
	disabledTools: [],
	usesComputer: false,
	naturalBrowsing: false,
	createdById: sam.id,
	visibility: "private",
	assistant: true,
	pinned: false,
	permissions: { ...MANAGER_OF_BOT, delete: false },
	createdAt: "2026-09-10T00:00:00.000Z",
};

/**
 * The two system bots the product ships. They belong to the workspace, so
 * they are not in the bot roster at all — they have their own
 * endpoint, and both arrive here already set up. A test that wants the
 * not-set-up state overrides one with `model: null`, so that state does not
 * become the ambient condition of every summary assertion in the suite.
 */
export const builtInBots: SystemBot[] = [
	{
		key: "summarise",
		name: "Summariser",
		description: "Keeps concise summaries of ongoing conversations.",
		color: "orange",
		face: "arc",
		shape: "circle",
		model: MODELS[1] as string,
	},
	{
		key: "compact",
		name: "Compaction",
		description: "Compacts long conversations so bots can keep reading them.",
		color: "purple",
		face: "square",
		shape: "circle",
		model: MODELS[0] as string,
	},
];

export const summariser = builtInBots[0] as SystemBot;
export const compaction = builtInBots[1] as SystemBot;

/** The id of `bot`'s default project, where its threads are. */
export function defaultProjectOf(bot: Bot): string {
	return `${bot.id.slice(0, -4)}f${bot.id.slice(-3)}`;
}

/** The first thread with `bot`, one per bot, by the bot's id. */
export function threadWith(bot: Bot): ProjectThread {
	return {
		kind: "project_thread",
		id: `${bot.id.slice(0, -4)}c${bot.id.slice(-3)}`,
		workspaceId: bot.workspaceId,
		projectId: defaultProjectOf(bot),
		botId: bot.id,
		title: `Working with ${bot.name}`,
		archivedAt: null,
		doneAt: null,
		createdAt: "2026-09-18T08:00:00.000Z",
		updatedAt: "2026-09-18T08:00:00.000Z",
	};
}

/** Another thread with `bot`, nothing said in it yet. */
export function conversationWith(bot: Bot): ProjectThread {
	return {
		...threadWith(bot),
		id: `${bot.id.slice(0, -4)}d${bot.id.slice(-3)}`,
		title: `Thread with ${bot.name}`,
	};
}

/** `thread`, a thread of `bot`'s, as the conversations API returns it, with nothing said yet. */
export function threadDetails(
	bot: Bot,
	thread: ProjectThread = threadWith(bot),
): ConversationDetails {
	const participant = {
		kind: "bot" as const,
		id: bot.id,
		name: bot.name,
		handle: bot.handle,
		color: bot.color,
		face: bot.face,
		shape: bot.shape,
	};
	const { kind: _kind, archivedAt: _archivedAt, ...conversation } = thread;
	return {
		conversation: {
			...conversation,
			rootConversationId: thread.id,
			kind: "project_thread",
			status: "done",
			parentConversationId: null,
			startedById: null,
		},
		automationRun: null,
		participants: [participant],
		projectBots: [participant],
		members: [],
		messages: [],
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
	};
}

/** A project's thread as its list shows it, with nothing new in it unless `standing` says. */
export function listedThread(
	thread: ProjectThread,
	standing: Partial<Omit<ListedThread, "conversation">> = {},
): ListedThread {
	return {
		conversation: thread,
		lastMessage: null,
		participants: [],
		messageCount: 1,
		waitingOn: null,
		unreadMessages: 0,
		needsApproval: false,
		mentionsYou: false,
		...standing,
	};
}

/** What the mocked API answers before a test says otherwise. */
export function apiAnswers({ role = "admin" }: { role?: WorkspaceRole } = {}): void {
	client.events.conversation.mockImplementation(() => quietEventStream());
	client.events.workspace.mockImplementation(() => quietEventStream());
	client.api.chats.projectMarkers.mockReturnValue(Effect.succeed({ projects: {}, bots: {} }));
	client.api.chats.approvals.mockReturnValue(Effect.succeed({ waiting: [], answered: [] }));
	client.api.chats.inbox.mockReturnValue(Effect.succeed({ items: [] }));
	client.api.chats.directMessages.mockReturnValue(Effect.succeed({ items: [] }));
	client.api.chats.markRead.mockReturnValue(Effect.succeed(undefined));
	client.api.chats.markItemRead.mockReturnValue(Effect.succeed(undefined));
	client.api.events.typing.mockReturnValue(Effect.succeed(undefined));
	client.api.notifications.reportPresence.mockReturnValue(Effect.succeed(undefined));
	client.api.notifications.settings.mockReturnValue(
		Effect.succeed({
			level: "mentions",
			pausedUntil: null,
			quietHours: null,
			turnFailures: true,
			automationRuns: "failures",
			projects: {},
			bots: {},
			mutedUntil: { projects: {}, bots: {} },
		}),
	);
	client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace]));
	client.api.workspaces.members.mockReturnValue(
		Effect.succeed([
			{
				id: "0199a3a0-0000-7000-8000-0000000000d1",
				role: "admin",
				user: sam,
				joinedAt: "2026-09-09T00:00:00.000Z",
			},
			{
				id: "0199a3a0-0000-7000-8000-0000000000d2",
				role: "member",
				user: juno,
				joinedAt: "2026-09-10T00:00:00.000Z",
			},
		]),
	);
	client.api.workspaces.updateMember.mockReturnValue(Effect.succeed(undefined));
	client.api.workspaces.removeMember.mockReturnValue(Effect.succeed(undefined));
	client.api.workspaces.leave.mockReturnValue(Effect.succeed(undefined));
	client.api.workspaces.cancelInvitation.mockReturnValue(Effect.succeed(undefined));
	client.api.workspaces.invitations.mockReturnValue(
		Effect.succeed([
			{
				id: "0199a3a0-0000-7000-8000-0000000000e1",
				email: "dana@example.com",
				role: "viewer",
				sentAt: "2026-09-22T00:00:00.000Z",
				expiresAt: "2026-09-24T00:00:00.000Z",
			},
		]),
	);
	client.api.workspaces.acceptInvitation.mockReturnValue(
		Effect.succeed({ workspaceId: WORKSPACE }),
	);
	const inProject = administersWorkspace(role)
		? ADMIN_IN_PROJECT
		: role === "member"
			? MEMBER_IN_PROJECT
			: VIEWER_IN_PROJECT;
	client.api.projects.list.mockReturnValue(
		Effect.succeed(
			projects.map((project) => ({ ...project, permissions: inProject }) satisfies Project),
		),
	);
	client.api.projects.listMembers.mockReturnValue(Effect.succeed([]));
	// Both of the seed's Suga-Team bots are in each project.
	client.api.projects.listBots.mockReturnValue(Effect.succeed([triager, linear]));
	// An administrator manages every bot; anyone else only uses the seed's, which they did not make.
	const onBot = administersWorkspace(role)
		? MANAGER_OF_BOT
		: role === "viewer"
			? { ...USER_OF_BOT, runAutomations: false, useDesktop: false }
			: USER_OF_BOT;
	client.api.bots.list.mockReturnValue(
		Effect.succeed([
			...bots.map((bot) => ({ ...bot, permissions: onBot }) satisfies Bot),
			personalAssistant,
		]),
	);
	client.api.bots.ensureAssistant.mockReturnValue(Effect.succeed(personalAssistant));
	client.api.systemBots.list.mockReturnValue(Effect.succeed(builtInBots));
	serveConnections();
	client.api.conversations.list.mockReturnValue(Effect.succeed([]));
	client.api.automations.list.mockReturnValue(Effect.succeed([]));
	client.api.automations.listInWorkspace.mockReturnValue(Effect.succeed({ items: [] }));
	client.api.automations.runs.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
	client.api.automations.getSecret.mockReturnValue(
		Effect.succeed({ kind: "set", secret: "whsec_0123456789abcdefghijklmnop" }),
	);
	// A project has nothing in it until a case says so.
	client.api.chats.list.mockReturnValue(Effect.succeed({ chats: [] }));
	const reachable = [...bots, personalAssistant];
	// Each bot has one thread, nothing said in it yet.
	client.api.chats.botThreads.mockImplementation(({ params }: { params: { botId: string } }) => {
		const bot = reachable.find((one) => one.id === params.botId);
		if (!bot) return Effect.fail(new NotFound({ message: userText`No such bot` }));
		return Effect.succeed({
			bot,
			threads: [listedThread(threadWith(bot))],
			automations: [],
			summary: null,
		});
	});
	client.api.chats.startInterview.mockReturnValue(Effect.succeed(null));
	client.api.chats.messages.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
	client.api.chats.history.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
	client.api.conversations.get.mockImplementation(
		({ params }: { params: { conversationId: string } }) => {
			const bot = reachable.find((one) => threadWith(one).id === params.conversationId);
			return bot
				? Effect.succeed(threadDetails(bot))
				: Effect.fail(new NotFound({ message: userText`No such conversation` }));
		},
	);
	client.api.conversations.activity.mockReturnValue(
		Effect.fail(new NotFound({ message: userText`No such conversation` })),
	);
	client.api.workspaceAccess.mockReturnValue(
		Effect.succeed({
			role,
			permissions: {
				createProjects: role !== "viewer",
				createBots: role !== "viewer",
				updateWorkspace: administersWorkspace(role),
				manageProviders: administersWorkspace(role),
				manageMembers: administersWorkspace(role),
				configureBuiltInBots: administersWorkspace(role),
				manageUsage: administersWorkspace(role),
				manageAdmins: role === "owner",
				transferOwnership: role === "owner",
				deleteWorkspace: role === "owner",
			},
		}),
	);
	client.api.modelProviders.list.mockReturnValue(Effect.succeed(modelProviders));
	client.api.searchProviders.webAccess.mockReturnValue(Effect.succeed({ enabled: true }));
	// No computers, unless a case sets one up.
	client.api.computerProviders.access.mockReturnValue(Effect.succeed({ enabled: false }));
	client.api.modelProviders.listEnabledModels.mockReturnValue(
		Effect.succeed({
			models: MODELS.map((modelId) => ({
				providerId: "0199a3a0-0000-7000-8000-0000000000c1",
				providerName: "Anthropic",
				providerPreset: "anthropic",
				providerActive: true,
				modelId,
				displayName: null,
				capabilities: ["tools"],
			})),
			defaultModel: MODELS[0] ?? null,
		}),
	);
}

/**
 * An answer a case gives later, to see what the page does while a request is
 * still in flight: the endpoint returns `effect`, which waits for `answer`.
 */
/** Answers a bot's connection reads from `connections` in full: the list with counts, and one connection with its tools. */
export function serveConnections(...connections: TestConnection[]): void {
	const byId = ({ params }: { params: { connectionId: string } }) =>
		connections.find((one) => one.id === params.connectionId);
	client.api.connections.list.mockReturnValue(Effect.succeed(connections.map(listedConnection)));
	client.api.connections.get.mockImplementation((input: { params: { connectionId: string } }) => {
		const found = byId(input);
		return found
			? Effect.succeed(connectionWithTools(found))
			: Effect.fail(new NotFound({ message: userText`No such connection` }));
	});
}

export function pendingAnswer() {
	const { promise, resolve } = Promise.withResolvers<Effect.Effect<unknown, unknown>>();
	return { effect: Effect.flatten(Effect.promise(() => promise)), answer: resolve };
}

function quietEventStream(...events: StreamEvent[]) {
	let finish = () => {};
	const closed = new Promise<void>((resolve) => {
		finish = resolve;
	});
	return {
		lastEventId: undefined,
		close: finish,
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield event;
			}
			await closed;
		},
	};
}

export function controlledEventStream() {
	const events: StreamEvent[] = [];
	let resume = () => {};
	let closed = false;
	const close = vi.fn(() => {
		closed = true;
		resume();
	});

	return {
		stream: {
			lastEventId: undefined,
			close,
			async *[Symbol.asyncIterator]() {
				while (!closed) {
					if (events.length === 0) {
						await new Promise<void>((resolve) => {
							resume = resolve;
						});
					}
					const event = events.shift();
					if (event) {
						yield event;
					}
				}
			},
		},
		emit(event: StreamEvent) {
			events.push(event);
			resume();
		},
		close,
	};
}

/**
 * Lays the app out as a computer's screen does, list and chat side by side,
 * for the rest of the test; without it a test sees a phone's layout.
 */
export function onWideScreen(): void {
	const matchMedia = window.matchMedia;
	vi.stubGlobal("matchMedia", (query: string) => ({
		...matchMedia(query),
		matches: query === SIDE_BY_SIDE,
	}));
	onTestFinished(() => {
		vi.unstubAllGlobals();
	});
}

export function mount(
	path: string,
	user: SessionUser | null = sam,
	refresh: () => Promise<void> = vi.fn(),
) {
	const router = createAppRouter({
		history: createMemoryHistory({ initialEntries: [path] }),
	});

	render(
		// A fresh cache per case, so one test's projects cannot answer another's.
		<TestApp
			router={router}
			queries={createQueryClient()}
			session={{ user, error: undefined, refresh }}
		/>,
	);

	return router;
}

/** The app as `main.tsx` mounts it, for a case that changes the session after mounting. */
export function TestApp({
	router,
	queries,
	session,
}: {
	router: ReturnType<typeof createAppRouter>;
	queries: QueryClient;
	session: Session;
}) {
	return (
		<QueryClientProvider client={queries}>
			<TooltipProvider>
				<AppRouterProvider router={router} session={session} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** Base UI menus and selects open on mousedown, which testing-library's click is not. */
export function open(trigger: Element): void {
	fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
	fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
}

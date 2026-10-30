import {
	type Agent,
	administersWorkspace,
	type BotChannel,
	type ConversationThread,
	type ModelProvider,
	type Pod,
	type PodPermissions,
	type SessionUser,
	type StreamEvent,
	type SystemAgent,
	type ThreadDetails,
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
export const jye: SessionUser = {
	id: "0199a3a0-0000-7000-8000-00000000000a",
	email: "jye@example.com",
	name: "Jye",
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

/** Every pod permission, as an admin gets them. */
const ADMIN_IN_POD: PodPermissions = {
	rename: true,
	manageMembers: true,
	leave: false,
	createAgents: true,
	updateAgents: true,
	deleteAgents: true,
	manageConnections: true,
	manageSandbox: true,
	useDesktops: true,
	manageRoutines: true,
	runRoutines: true,
	deleteArtifacts: true,
};

/** What a member gets in a shared pod they have joined. */
const MEMBER_IN_POD: PodPermissions = {
	...ADMIN_IN_POD,
	rename: false,
	manageMembers: false,
	leave: true,
	deleteAgents: false,
	manageConnections: false,
	manageSandbox: false,
	manageRoutines: false,
	runRoutines: false,
	deleteArtifacts: false,
};

/** What a viewer gets there: nothing they could change. */
export const VIEWER_IN_POD: PodPermissions = {
	...MEMBER_IN_POD,
	createAgents: false,
	updateAgents: false,
};

/**
 * What its owner gets in their own Personal pod: everything except the two the
 * API refuses to everybody, because a Personal pod keeps its name and is one
 * person's.
 */
export const OWN_PERSONAL_POD: PodPermissions = {
	...ADMIN_IN_POD,
	rename: false,
	manageMembers: false,
	leave: false,
};

/** The two the dev seed makes. */
export const pods: Pod[] = [
	{
		ownerId: null,
		kind: "shared",
		id: "0199a3a0-0000-7000-8000-0000000000a1",
		workspaceId: WORKSPACE,
		name: "Suga-Team",
		slug: "suga-team",
		color: "green",
		permissions: ADMIN_IN_POD,
		createdAt: "2026-09-09T00:00:00.000Z",
	},
	{
		ownerId: null,
		kind: "shared",
		id: "0199a3a0-0000-7000-8000-0000000000a2",
		workspaceId: WORKSPACE,
		name: "Sales",
		slug: "sales",
		color: "blue",
		permissions: ADMIN_IN_POD,
		createdAt: "2026-09-09T00:00:00.000Z",
	},
];

/** Sam's Personal pod, which the default `pods` answer leaves out. */
export const personalPod: Pod = {
	ownerId: sam.id,
	kind: "personal",
	id: "0199a3a0-0000-7000-8000-0000000000af",
	workspaceId: WORKSPACE,
	name: "Personal",
	slug: "personal",
	color: null,
	permissions: OWN_PERSONAL_POD,
	createdAt: "2026-09-09T00:00:00.000Z",
};

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

export const agents: Agent[] = [
	{
		id: "0199a3a0-0000-7000-8000-0000000000b1",
		workspaceId: WORKSPACE,
		systemAgentKey: null,
		name: "Customer Research",
		handle: "customer-research",
		description: "Digs through calls and notes for what customers asked for.",
		color: "purple",
		face: "dot",
		shape: "circle",
		model: MODELS[1] as string,
		prompt: "",
		disabledTools: [],
		usesSandbox: false,
		naturalBrowsing: false,
		createdById: null,
		podId: pods[1]?.id as string,
		createdAt: "2026-09-10T00:00:00.000Z",
	},
	{
		id: "0199a3a0-0000-7000-8000-0000000000b2",
		workspaceId: WORKSPACE,
		systemAgentKey: null,
		name: "Issue Triager",
		handle: "issue-triager",
		description: "Sorts incoming issues every weekday morning.",
		color: "green",
		face: "arc",
		shape: "circle",
		model: MODELS[0] as string,
		prompt: "",
		disabledTools: [],
		usesSandbox: false,
		naturalBrowsing: false,
		createdById: null,
		podId: pods[0]?.id as string,
		createdAt: "2026-09-10T00:00:00.000Z",
	},
	{
		id: "0199a3a0-0000-7000-8000-0000000000b3",
		workspaceId: WORKSPACE,
		systemAgentKey: null,
		name: "Linear Handler",
		handle: "linear-handler",
		description: "Reads and writes Linear on the team's behalf.",
		color: "sky",
		face: "pill",
		shape: "circle",
		model: MODELS[0] as string,
		prompt: "Be brief.",
		disabledTools: [],
		usesSandbox: false,
		naturalBrowsing: false,
		createdById: sam.id,
		podId: pods[0]?.id as string,
		createdAt: "2026-09-10T00:00:00.000Z",
	},
];

export const linear = agents[2] as Agent;
export const triager = agents[1] as Agent;

/** The assistant in `personalPod`, which the default `agents` answer leaves out. */
export const personalAssistant: Agent = {
	id: "0199a3a0-0000-7000-8000-0000000000bf",
	workspaceId: WORKSPACE,
	systemAgentKey: null,
	name: "Personal Assistant",
	handle: "personal-assistant",
	description: "Your private assistant.",
	color: "green",
	face: "pill",
	shape: "circle",
	model: MODELS[1] as string,
	prompt: "",
	disabledTools: [],
	usesSandbox: false,
	naturalBrowsing: false,
	createdById: null,
	podId: personalPod.id,
	createdAt: "2026-09-10T00:00:00.000Z",
};

/**
 * The two agents the product ships. They belong to the workspace rather than to
 * a pod, so they are not in the agent roster at all — they have their own
 * endpoint, and both arrive here already set up. A test that wants the
 * not-set-up state overrides one with `model: null`, so that state does not
 * become the ambient condition of every summary assertion in the suite.
 */
export const builtInAgents: SystemAgent[] = [
	{
		key: "summarise",
		name: "Scribe",
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

export const scribe = builtInAgents[0] as SystemAgent;
export const compaction = builtInAgents[1] as SystemAgent;

/** The conversation with `agent`, one per bot, by the bot's id. */
export function channelWith(agent: Agent): BotChannel {
	return {
		kind: "bot_channel",
		id: `${agent.id.slice(0, -4)}c${agent.id.slice(-3)}`,
		workspaceId: agent.workspaceId,
		podId: agent.podId,
		hostAgentId: agent.id,
		title: agent.name,
		createdAt: "2026-09-18T08:00:00.000Z",
		updatedAt: "2026-09-18T08:00:00.000Z",
	};
}

/** A thread with `agent`, nothing said in it yet. */
export function threadWith(agent: Agent): ConversationThread {
	return {
		kind: "thread",
		id: `${agent.id.slice(0, -4)}d${agent.id.slice(-3)}`,
		workspaceId: agent.workspaceId,
		podId: agent.podId,
		hostAgentId: agent.id,
		title: `Thread with ${agent.name}`,
		startedInChatId: null,
		doneAt: null,
		createdAt: "2026-09-18T08:00:00.000Z",
		updatedAt: "2026-09-18T08:00:00.000Z",
	};
}

/** The channel of `agent` as the thread API returns it, with nothing said yet. */
export function channelDetails(agent: Agent): ThreadDetails {
	const conversation = channelWith(agent);
	const participant = {
		kind: "agent" as const,
		id: agent.id,
		name: agent.name,
		handle: agent.handle,
		color: agent.color,
		face: agent.face,
		shape: agent.shape,
	};
	const { kind: _kind, ...thread } = conversation;
	return {
		thread: {
			...thread,
			conversationId: conversation.id,
			type: "bot_channel",
			status: "done",
			parentThreadId: null,
			initiatorUserId: null,
			doneAt: null,
		},
		routineExecution: null,
		startedFrom: null,
		participants: [participant],
		crew: [participant],
		members: [],
		messages: [],
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
	};
}

/** What the mocked API answers before a test says otherwise. */
export function apiAnswers({ role = "admin" }: { role?: WorkspaceRole } = {}): void {
	client.events.thread.mockImplementation(() => quietEventStream());
	client.events.workspace.mockImplementation(() => quietEventStream());
	client.api.chats.podMarkers.mockReturnValue(Effect.succeed({ pods: {} }));
	client.api.chats.approvals.mockReturnValue(Effect.succeed({ waiting: [], answered: [] }));
	client.api.chats.activity.mockReturnValue(Effect.succeed({ items: [] }));
	client.api.chats.markRead.mockReturnValue(Effect.succeed(undefined));
	client.api.events.typing.mockReturnValue(Effect.succeed(undefined));
	client.api.notifications.reportPresence.mockReturnValue(Effect.succeed(undefined));
	client.api.notifications.settings.mockReturnValue(
		Effect.succeed({
			level: "mentions",
			pausedUntil: null,
			quietHours: null,
			turnFailures: true,
			routineRuns: "failures",
			pods: {},
			bots: {},
			mutedUntil: { pods: {}, bots: {} },
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
				user: jye,
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
				expiresAt: "2026-09-24T00:00:00.000Z",
			},
		]),
	);
	client.api.workspaces.acceptInvitation.mockReturnValue(
		Effect.succeed({ workspaceId: WORKSPACE }),
	);
	const inPod = administersWorkspace(role)
		? ADMIN_IN_POD
		: role === "member"
			? MEMBER_IN_POD
			: VIEWER_IN_POD;
	client.api.pods.list.mockReturnValue(
		Effect.succeed(pods.map((pod) => ({ ...pod, permissions: inPod }) satisfies Pod)),
	);
	client.api.pods.ensurePersonal.mockReturnValue(Effect.succeed(pods[0]));
	client.api.pods.listMembers.mockReturnValue(Effect.succeed([]));
	client.api.agents.list.mockReturnValue(Effect.succeed(agents));
	client.api.systemAgents.list.mockReturnValue(Effect.succeed(builtInAgents));
	serveConnections();
	client.api.threads.list.mockReturnValue(Effect.succeed([]));
	client.api.routines.list.mockReturnValue(Effect.succeed([]));
	client.api.routines.listInWorkspace.mockReturnValue(Effect.succeed({ items: [] }));
	client.api.routines.executions.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
	client.api.routines.getSecret.mockReturnValue(
		Effect.succeed({ kind: "set", secret: "whsec_0123456789abcdefghijklmnop" }),
	);
	// A channel for every crew bot in the pod, nothing said in any yet.
	client.api.chats.list.mockImplementation(({ query }: { query: { pod: string } }) => {
		const pod = pods.find((one) => one.slug === query.pod || one.id === query.pod);
		return Effect.succeed({
			chats: [],
			routines: [],
			threads: [],
			channels: agents
				.filter((agent) => agent.systemAgentKey === null && agent.podId === pod?.id)
				.map((agent) => ({
					agent,
					conversation: channelWith(agent),
					unreadMessages: 0,
					needsApproval: false,
					mentionsYou: false,
				})),
		});
	});
	const crew = [...agents, personalAssistant];
	client.api.chats.openBotChannel.mockImplementation(
		({ payload }: { payload: { hostAgentId: string } }) => {
			const agent = crew.find((one) => one.id === payload.hostAgentId);
			return agent
				? Effect.succeed(channelWith(agent))
				: Effect.fail(new NotFound({ message: userText`No channel fixture` }));
		},
	);
	client.api.chats.openPodChat.mockReturnValue(
		Effect.fail(new NotFound({ message: userText`No pod chat fixture` })),
	);
	client.api.chats.messages.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
	client.api.chats.history.mockReturnValue(Effect.succeed({ items: [], nextCursor: null }));
	client.api.threads.get.mockImplementation(({ params }: { params: { threadId: string } }) => {
		const agent = crew.find((one) => channelWith(one).id === params.threadId);
		return agent
			? Effect.succeed(channelDetails(agent))
			: Effect.fail(new NotFound({ message: userText`No such thread` }));
	});
	client.api.threads.activity.mockReturnValue(
		Effect.fail(new NotFound({ message: userText`No such thread` })),
	);
	client.api.workspaceAccess.mockReturnValue(
		Effect.succeed({
			role,
			permissions: {
				createPods: administersWorkspace(role),
				updateWorkspace: administersWorkspace(role),
				manageProviders: administersWorkspace(role),
				manageMembers: administersWorkspace(role),
				configureBuiltInAgents: administersWorkspace(role),
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
	client.api.sandboxProviders.access.mockReturnValue(Effect.succeed({ enabled: false }));
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
/** Answers the pod's connection reads from `connections` in full: the list with counts, and one connection with its tools. */
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

export function quietEventStream(...events: StreamEvent[]) {
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
		// A fresh cache per case, so one test's pods cannot answer another's.
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

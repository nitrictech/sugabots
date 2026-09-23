import {
	type Agent,
	DEFAULT_POD_ROUTING,
	type ModelProvider,
	type Pod,
	type PodPermissions,
	type SessionUser,
	type StreamEvent,
	type SystemAgent,
	type WorkspaceRole,
} from "@sugabots/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render } from "@testing-library/react";
import { vi } from "vitest";
import { createQueryClient } from "@/lib/query.ts";
import { createAppRouter } from "@/router.tsx";
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

export const workspace = { id: WORKSPACE, name: "Suga Workspace", slug: "suga" };

/** Every pod permission, as an admin gets them. */
const ADMIN_IN_POD: PodPermissions = {
	rename: true,
	changeRouting: true,
	manageMembers: true,
	createAgents: true,
	updateAgents: true,
	deleteAgents: true,
	manageConnections: true,
	manageRoutines: true,
	runRoutines: true,
};

/** What a member gets in a shared pod they have joined. */
const MEMBER_IN_POD: PodPermissions = {
	...ADMIN_IN_POD,
	rename: false,
	changeRouting: false,
	manageMembers: false,
	deleteAgents: false,
	manageConnections: false,
	manageRoutines: false,
	runRoutines: false,
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
		routing: DEFAULT_POD_ROUTING,
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
		routing: DEFAULT_POD_ROUTING,
		permissions: ADMIN_IN_POD,
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
		apiKeyHint: "1234",
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
		apiKeyHint: "5678",
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
		hue: 310,
		face: "dots",
		model: MODELS[1] as string,
		prompt: "",
		disabledTools: [],
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
		hue: 150,
		face: "smile",
		model: MODELS[0] as string,
		prompt: "",
		disabledTools: [],
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
		hue: 250,
		face: "bar",
		model: MODELS[0] as string,
		prompt: "Be brief.",
		disabledTools: [],
		podId: pods[0]?.id as string,
		createdAt: "2026-09-10T00:00:00.000Z",
	},
];

export const linear = agents[2] as Agent;
export const triager = agents[1] as Agent;

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
		hue: 36,
		face: "smile",
		model: MODELS[1] as string,
	},
	{
		key: "facilitate",
		name: "Facilitator",
		description: "Decides who speaks next when nobody was addressed.",
		hue: 205,
		face: "bar",
		model: MODELS[0] as string,
	},
];

export const scribe = builtInAgents[0] as SystemAgent;
export const facilitator = builtInAgents[1] as SystemAgent;

/** What the mocked API answers before a test says otherwise. */
export function apiAnswers({ role = "admin" }: { role?: WorkspaceRole } = {}): void {
	client.events.thread.mockImplementation(() => quietEventStream());
	client.events.workspace.mockImplementation(() => quietEventStream());
	client.auth.workspaces.list.mockResolvedValue([workspace]);
	client.auth.workspaces.members.mockResolvedValue([
		{
			id: "0199a3a0-0000-7000-8000-0000000000d1",
			organizationId: WORKSPACE,
			userId: sam.id,
			role: "admin",
			createdAt: new Date("2026-09-09T00:00:00.000Z"),
			user: sam,
		},
		{
			id: "0199a3a0-0000-7000-8000-0000000000d2",
			organizationId: WORKSPACE,
			userId: jye.id,
			role: "member",
			createdAt: new Date("2026-09-10T00:00:00.000Z"),
			user: jye,
		},
	]);
	client.auth.workspaces.updateRole.mockResolvedValue(undefined);
	client.auth.workspaces.removeMember.mockResolvedValue(undefined);
	client.auth.workspaces.leave.mockResolvedValue(undefined);
	client.auth.workspaces.cancelInvite.mockResolvedValue(undefined);
	client.auth.workspaces.invitations.mockResolvedValue([
		{
			id: "0199a3a0-0000-7000-8000-0000000000e1",
			email: "dana@example.com",
			role: "viewer",
			status: "pending",
			organizationId: WORKSPACE,
			inviterId: sam.id,
			expiresAt: new Date("2026-09-24T00:00:00.000Z"),
		},
	]);
	client.api.onboarding.$get.mockResolvedValue(Response.json({ completed: true }));
	client.api.onboarding["complete-invite"].$post.mockImplementation(async () =>
		client.auth.workspaces.acceptInvite.mock.calls.length > 0
			? Response.json({ workspaceId: WORKSPACE })
			: Response.json({ error: { code: "bad_request", message: "Pending" } }, { status: 400 }),
	);
	const inPod = role === "admin" ? ADMIN_IN_POD : role === "member" ? MEMBER_IN_POD : VIEWER_IN_POD;
	client.api.workspaces[":workspaceId"].pods.$get.mockResolvedValue(
		Response.json(pods.map((pod) => ({ ...pod, permissions: inPod }) satisfies Pod)),
	);
	client.api.workspaces[":workspaceId"]["personal-pod"].$post.mockResolvedValue(
		Response.json(pods[0], { status: 201 }),
	);
	// Asked once per pod, and a Response body reads once, so a fresh one each time.
	client.api.pods[":podId"].members.$get.mockImplementation(async () => Response.json([]));
	client.api.workspaces[":workspaceId"].agents.$get.mockResolvedValue(Response.json(agents));
	client.api.workspaces[":workspaceId"]["system-agents"].$get.mockResolvedValue(
		Response.json(builtInAgents),
	);
	client.api.pods[":podId"].connections.$get.mockResolvedValue(Response.json([]));
	client.api.pods[":podId"]["tool-approval-rules"].$get.mockResolvedValue(Response.json([]));
	client.api.workspaces[":workspaceId"].threads.$get.mockResolvedValue(Response.json([]));
	client.api.agents[":agentId"].routines.$get.mockResolvedValue(Response.json([]));
	client.api.workspaces[":workspaceId"].chats.$post.mockResolvedValue(
		Response.json({ error: { code: "not_found", message: "No chat fixture" } }, { status: 404 }),
	);
	client.api.chats[":chatId"].messages.$get.mockResolvedValue(
		Response.json({ items: [], nextCursor: null }),
	);
	client.api.chats[":chatId"].history.$get.mockResolvedValue(
		Response.json({ items: [], nextCursor: null }),
	);
	client.api.threads[":threadId"].$get.mockResolvedValue(
		Response.json({ error: { code: "not_found", message: "No such thread" } }, { status: 404 }),
	);
	client.api.workspaces[":workspaceId"].me.$get.mockResolvedValue(
		Response.json({
			role,
			permissions: {
				createPods: role === "admin",
				manageProviders: role === "admin",
				manageMembers: role === "admin",
				configureBuiltInAgents: role === "admin",
			},
		}),
	);
	client.api.workspaces[":workspaceId"]["model-providers"].$get.mockResolvedValue(
		Response.json(modelProviders),
	);
	client.api.workspaces[":workspaceId"]["model-providers"].models.$get.mockResolvedValue(
		Response.json({
			models: MODELS.map((modelId) => ({
				providerId: "0199a3a0-0000-7000-8000-0000000000c1",
				providerName: "Anthropic",
				providerPreset: "anthropic",
				providerActive: true,
				modelId,
				displayName: null,
			})),
		}),
	);
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
		<QueryClientProvider client={createQueryClient()}>
			<TooltipProvider>
				<RouterProvider
					router={router}
					context={{ session: { user, error: undefined, refresh } }}
				/>
			</TooltipProvider>
		</QueryClientProvider>,
	);

	return router;
}

/** Base UI menus and selects open on mousedown, which testing-library's click is not. */
export function open(trigger: Element): void {
	fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
	fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
}

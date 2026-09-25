import type { SessionUser } from "@sugabots/contracts";
import type { ChatStore } from "@sugabots/core/conversations/chats/store";
import type { RoutineStore } from "@sugabots/core/conversations/routines/store";
import type { ThreadStore } from "@sugabots/core/conversations/threads/store";
import { noToolApprovalStore } from "@sugabots/core/conversations/tools/approvals/store";
import { ModelRequestFailed, type TurnModel } from "@sugabots/core/conversations/turns/model";
import { Credentials } from "@sugabots/core/credentials/credentials";
import { createEventBus, type EventBus } from "@sugabots/core/database/events/bus";
import { memoryEventStore } from "@sugabots/core/database/events/store";
import { noDatabase } from "@sugabots/core/database/testing";
import { Installation } from "@sugabots/core/installation/installation";
import type { ConnectionStore } from "@sugabots/core/providers/connections/store";
import type { ModelProviderStore } from "@sugabots/core/providers/model-providers/store";
import type {
	EgressHttpClients,
	EgressUrlValidator,
} from "@sugabots/core/providers/network/egress";
import type { SandboxProviderStore } from "@sugabots/core/providers/sandbox-providers/store";
import type { SearchProviderStore } from "@sugabots/core/providers/search-providers/store";
import { type Authorization, closedAuthorization } from "@sugabots/core/workspaces/access";
import { type AgentStore, crewAgentRow, toAgent } from "@sugabots/core/workspaces/agents/store";
import type { SystemAgentStore } from "@sugabots/core/workspaces/agents/system-agent-store";
import type { Membership } from "@sugabots/core/workspaces/membership/membership";
import type { OnboardingStore } from "@sugabots/core/workspaces/onboarding/store";
import type { PodStore } from "@sugabots/core/workspaces/pods/store";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import type { Authentication } from "../auth/authentication.ts";
import { type ChannelAccess, closedChannelAccess } from "../routes/events/access.ts";
import type { StreamOptions } from "../routes/events/routes.ts";
import { API_BASE_PATH } from "./api.ts";
import { apiLayer, type Stores } from "./app.ts";

type TestIdentity =
	| { authentication: Authentication.Interface; resolveUser?: never }
	| { authentication?: never; resolveUser: UserResolver };

type TestAppOptions = TestIdentity & {
	/** Where the web app is served, when a case needs it apart from the API. */
	webAppUrl?: string;
	events?: { bus?: EventBus; access?: ChannelAccess; stream?: StreamOptions };
	authorization?: Authorization;
	membership?: Membership.Interface;
	/** The stores a case is about. Anything left out answers nothing. */
	stores?: Partial<Stores>;
	httpClients?: EgressHttpClients;
	validateProviderUrl?: EgressUrlValidator;
	model?: TurnModel;
};

const TEST_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");

/** The test API's address. */
export const BASE_URL = "http://localhost:3000";
/** Where the test app's web app is served, a browser origin it trusts besides its own. */
export const WEB_ORIGIN = "http://localhost:5173";

export interface TestApp {
	/** A request to `path` under `API_BASE_PATH`, e.g. `/agents/…`. */
	request(path: string, init?: RequestInit): Promise<Response>;
	/** A request as the server receives it, at any path. */
	fetch(request: Request): Promise<Response>;
}

/**
 * The complete route table over fakes that grant nothing, reach nothing and
 * store nothing, so a case supplies only what it is about.
 */
export function createTestApp(options: TestAppOptions): TestApp {
	const bus = options.events?.bus ?? createEventBus({ store: memoryEventStore() });
	const routes = apiLayer({
		authentication: options.authentication ?? authenticationForResolver(options.resolveUser),
		installation: Installation.fromUrls({
			isProduction: false,
			publicUrl: BASE_URL,
			webAppUrl: options.webAppUrl ?? WEB_ORIGIN,
		}),
		authorization: options.authorization ?? closedAuthorization(),
		membership: options.membership ?? noMembership,
		stores: { ...emptyStores, ...options.stores },
		events: {
			bus,
			access: options.events?.access ?? closedChannelAccess(),
			stream: options.events?.stream,
		},
		model: options.model ?? {
			stream: () => Effect.fail(new ModelRequestFailed({ message: "This test app has no model" })),
		},
		httpClients: options.httpClients ?? {
			for: () => async () => new Response(null, { status: 503 }),
		},
		validateProviderUrl: options.validateProviderUrl ?? (async () => {}),
		oauthFetch: async () => new Response(null, { status: 503 }),
		credentials: Credentials.fromKey(TEST_CREDENTIAL_KEY),
	}).pipe(Layer.provide([noDatabase, HttpServer.layerServices]));
	const { handler } = HttpRouter.toWebHandler(routes, { disableLogger: true });
	return {
		request: (path, init) =>
			handler(new Request(new URL(`${API_BASE_PATH}${path}`, BASE_URL), init)),
		fetch: (request) => handler(request),
	};
}

function authenticationForResolver(resolveUser: UserResolver): Authentication.Interface {
	return {
		handler: () => Effect.succeed(new Response(null, { status: 404 })),
		identify: identifyFromResolver(resolveUser),
	};
}

/**
 * A store method a test app never wires but the interface requires. Dying names
 * the method, rather than handing back an `undefined` typed as a real value
 * that fails somewhere else entirely.
 */
function notStubbed(method: string): Effect.Effect<never> {
	return Effect.die(new Error(`${method} has no test double. Pass one to createTestApp.`));
}

const emptyPodStore: PodStore = {
	listVisible: () => Effect.succeed([]),
	create: () => notStubbed("pods.create"),
	ensurePersonal: () => notStubbed("pods.ensurePersonal"),
	update: () => notStubbed("pods.update"),
	remove: () => Effect.void,
	listMembers: () => Effect.succeed([]),
	addMember: () => Effect.succeed("not_workspace_member"),
	removeMember: () => Effect.succeed("not_a_member" as const),
};

const emptyAgentStore: AgentStore = {
	listVisible: () => Effect.succeed([]),
	get: () => Effect.undefined,
	fromRow: (row) => {
		const crew = crewAgentRow(row);
		return Effect.succeed(crew ? toAgent(crew) : undefined);
	},
	create: () => notStubbed("agents.create"),
	update: () => notStubbed("agents.update"),
	remove: () => Effect.void,
};

const emptyThreadStore: ThreadStore = {
	listVisible: () => Effect.succeed([]),
	visibleThreadId: () => Effect.undefined,
	getVisible: () => Effect.undefined,
	activity: () => Effect.undefined,
};

const emptyChatStore: ChatStore = {
	list: () => Effect.succeed({ items: [] }),
	getOrCreate: () => notStubbed("chats.getOrCreate"),
	messages: () => Effect.undefined,
	history: () => Effect.undefined,
	sendMain: () => Effect.undefined,
};

const emptyRoutineStore: RoutineStore = {
	listInWorkspace: () => Effect.succeed([]),
	list: () => Effect.succeed([]),
	get: () => Effect.undefined,
	create: () => notStubbed("routines.create"),
	update: () => notStubbed("routines.update"),
	remove: () => Effect.void,
	acceptTrigger: () => notStubbed("routines.acceptTrigger"),
	listExecutions: () => Effect.undefined,
	claimNext: () => Effect.undefined,
	settleThread: () => Effect.succeed(false),
	reconcileRunning: () => Effect.void,
	processNextDue: () => Effect.undefined,
	rotateSecret: () => notStubbed("routines.rotateSecret"),
	acceptWebhook: () => Effect.undefined,
};

const emptyConnectionStore: ConnectionStore = {
	list: () => Effect.succeed([]),
	get: () => Effect.undefined,
	create: () => notStubbed("connections.create"),
	update: () => Effect.undefined,
	remove: () => Effect.succeed(false),
	target: () => Effect.undefined,
	targetsForPod: () => Effect.succeed([]),
	recordTest: () => Effect.void,
	oauthRecord: () => Effect.undefined,
	saveOauthRecord: () => Effect.void,
	byOauthState: () => Effect.undefined,
};

const emptySearchProviderStore: SearchProviderStore = {
	get: () => Effect.undefined,
	replace: () => notStubbed("searchProviders.replace"),
	update: () => Effect.undefined,
	remove: () => Effect.succeed(false),
	connection: () => Effect.undefined,
	resolve: () => Effect.undefined,
	recordTest: () => Effect.void,
};

const emptySandboxProviderStore: SandboxProviderStore = {
	get: () => Effect.undefined,
	replace: () => notStubbed("sandboxProviders.replace"),
	update: () => Effect.undefined,
	remove: () => Effect.succeed(false),
	connection: () => Effect.undefined,
	resolve: () => Effect.undefined,
	recordTest: () => Effect.void,
};

const emptyModelProviderStore: ModelProviderStore = {
	list: () => Effect.succeed([]),
	get: () => Effect.undefined,
	create: () => notStubbed("modelProviders.create"),
	update: () => Effect.undefined,
	remove: () => Effect.succeed(false),
	saveChatgptSignIn: () => Effect.undefined,
	renewChatgptTokens: () => Effect.undefined,
	connection: () => Effect.undefined,
	resolve: () => Effect.undefined,
	recordTest: () => Effect.void,
	addModels: () => Effect.succeed(0),
	syncDiscovered: () => Effect.succeed({ added: 0, updated: 0 }),
	setModelEnabled: () => Effect.succeed(0),
	updateModel: () => Effect.succeed(0),
	removeModel: () => Effect.succeed(false),
	listEnabled: () => Effect.succeed({ models: [] }),
	isEnabled: () => Effect.succeed(false),
};

const emptyOnboardingStore: OnboardingStore = {
	isCompleted: () => Effect.succeed(true),
	complete: () => Effect.succeed(false),
	completeAcceptedInvite: () => Effect.undefined,
};

const emptySystemAgentStore: SystemAgentStore = {
	list: () => Effect.succeed([]),
	setModel: () => notStubbed("systemAgents.setModel"),
};

const emptyStores: Stores = {
	pods: emptyPodStore,
	agents: emptyAgentStore,
	systemAgents: emptySystemAgentStore,
	onboarding: emptyOnboardingStore,
	modelProviders: emptyModelProviderStore,
	searchProviders: emptySearchProviderStore,
	sandboxProviders: emptySandboxProviderStore,
	podSandboxes: {
		applyAllowedHosts: () => Effect.succeed({ applied: 0, notApplied: 0 }),
		status: () =>
			Effect.succeed({
				state: "none",
				usedBy: [],
				isolation: null,
				lastUsedAt: null,
				createdAt: null,
			}),
	},
	connections: emptyConnectionStore,
	threads: emptyThreadStore,
	chats: emptyChatStore,
	routines: emptyRoutineStore,
	turns: { requestCancel: () => Effect.succeed(false) },
	approvals: noToolApprovalStore,
};

const unused = () => Effect.die(new Error("This test app has no membership"));

/** Belongs to no workspace, and fails any case that reaches further. */
const noMembership: Membership.Interface = {
	workspaces: () => Effect.succeed([]),
	create: unused,
	update: unused,
	members: unused,
	changeRole: unused,
	remove: unused,
	leave: unused,
	invitations: unused,
	invite: unused,
	cancelInvitation: unused,
	invitation: unused,
	accept: unused,
};

/** Who a test says holds the credentials in `headers`, so HTTP tests run without a database. */
export type UserResolver = (headers: Headers) => Promise<SessionUser | null>;

/** The `Authentication.identify` a test's resolver stands in for. */
export function identifyFromResolver(resolveUser: UserResolver) {
	return (headers: Headers) =>
		Effect.map(
			Effect.promise(() => resolveUser(headers)),
			(user) => user ?? undefined,
		);
}

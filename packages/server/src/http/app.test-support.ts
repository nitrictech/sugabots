import type { SessionUser } from "@sugabots/contracts";
import type { ChatStore } from "@sugabots/core/conversations/chats/store";
import type { RoutineStore } from "@sugabots/core/conversations/routines/store";
import type { ThreadStore } from "@sugabots/core/conversations/threads/store";
import { noToolApprovalStore } from "@sugabots/core/conversations/tools/approvals/store";
import { ModelRequestFailed, type TurnModel } from "@sugabots/core/conversations/turns/model";
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
import type { SearchProviderStore } from "@sugabots/core/providers/search-providers/store";
import { unimplemented } from "@sugabots/core/testing";
import { type Authorization, closedAuthorization } from "@sugabots/core/workspaces/access";
import { AgentAdministration } from "@sugabots/core/workspaces/agents/agent-administration";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { PodAdministration } from "@sugabots/core/workspaces/pods/pod-administration";
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

type TestAppOptions<Provided> = TestIdentity & {
	/** Where the web app is served, when a case needs it apart from the API. */
	webAppUrl?: string;
	events?: { bus?: EventBus; access?: ChannelAccess; stream?: StreamOptions };
	authorization?: Authorization;
	/** The services a case is about, in place of the unimplemented ones. */
	services?: Layer.Layer<Provided>;
	/** The stores a case is about. Anything left out answers nothing. */
	stores?: Partial<Stores>;
	httpClients?: EgressHttpClients;
	validateProviderUrl?: EgressUrlValidator;
	model?: TurnModel;
};

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
export function createTestApp<Provided extends Layer.Success<typeof emptyServices> = never>(
	options: TestAppOptions<Provided>,
): TestApp {
	const bus = options.events?.bus ?? createEventBus({ store: memoryEventStore() });
	const routes = apiLayer({
		authentication: options.authentication ?? authenticationForResolver(options.resolveUser),
		installation: Installation.fromUrls({
			isProduction: false,
			publicUrl: BASE_URL,
			webAppUrl: options.webAppUrl ?? WEB_ORIGIN,
		}),
		authorization: options.authorization ?? closedAuthorization(),
		stores: { ...emptyStores, ...options.stores },
		events: {
			bus,
			access: options.events?.access ?? closedChannelAccess(),
			stream: options.events?.stream,
		},
		model: options.model ?? {
			stream: () =>
				Effect.fail(
					new ModelRequestFailed({ message: "This test app has no model", reason: "unavailable" }),
				),
		},
		httpClients: options.httpClients ?? {
			for: () => async () => new Response(null, { status: 503 }),
		},
		validateProviderUrl: options.validateProviderUrl ?? (async () => {}),
		oauthFetch: async () => new Response(null, { status: 503 }),
	}).pipe(
		Layer.provide(Layer.merge(emptyServices, options.services ?? Layer.empty)),
		Layer.provide([noDatabase, HttpServer.layerServices]),
	);
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
	startRun: () => Effect.void,
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

const emptyModelProviderStore: ModelProviderStore = {
	list: () => Effect.succeed([]),
	get: () => Effect.undefined,
	create: () => notStubbed("modelProviders.create"),
	update: () => Effect.undefined,
	remove: () => Effect.succeed(false),
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

const emptyStores: Stores = {
	modelProviders: emptyModelProviderStore,
	searchProviders: emptySearchProviderStore,
	connections: emptyConnectionStore,
	threads: emptyThreadStore,
	chats: emptyChatStore,
	routines: emptyRoutineStore,
	turns: { requestCancel: () => Effect.succeed(false) },
	approvals: noToolApprovalStore,
};

/**
 * Services whose every method dies naming itself, so a case supplies, through
 * `services`, exactly the ones it is about.
 */
const emptyServices = Layer.mergeAll(
	unimplemented(Membership.Service),
	unimplemented(PodAdministration.Service),
	unimplemented(AgentAdministration.Service),
	unimplemented(Onboarding.Service),
);

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

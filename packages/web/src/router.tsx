import type { QueryClient } from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import {
	createRootRouteWithContext,
	createRoute,
	createRouter,
	Link,
	lazyRouteComponent,
	Navigate,
	notFound,
	redirect,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { agentsQuery, findPodAgent, firstCrewAgent, useAgents, usePodAgent } from "@/lib/agents.ts";
import { isBuiltInAgentKey } from "@/lib/built-in-agents.ts";
import { agentChatLink } from "@/lib/links.ts";
import { useOnboarding } from "@/lib/onboarding.ts";
import { findPod, podsQuery, usePods } from "@/lib/pods.ts";
import { findWithCachedQueries } from "@/lib/query.ts";
import type { Session } from "@/lib/session.ts";
import {
	chooseWorkspace,
	rememberedWorkspace,
	useWorkspace,
	WorkspaceSlugContext,
	workspacesQuery,
} from "@/lib/workspace.ts";
import {
	isPodSettingsTab,
	type PodSettingsTab,
	workspaceSettingSection,
} from "@/lib/workspace-settings.ts";
import { SettingsDialog } from "@/screens/SettingsDialog.tsx";
import { Panes, Shell } from "@/shell/Shell.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";

const AgentPage = lazyRouteComponent(() => import("@/screens/AgentPage.tsx"), "AgentPage");
const Invite = lazyRouteComponent(() => import("@/screens/Invite.tsx"), "Invite");
const Login = lazyRouteComponent(() => import("@/screens/Login.tsx"), "Login");
const Onboarding = lazyRouteComponent(() => import("@/screens/Onboarding.tsx"), "Onboarding");
const ThreadPage = lazyRouteComponent(() => import("@/screens/ThreadPage.tsx"), "ThreadPage");
/*
 * The settings sections are a chunk of their own; the window they open in is
 * not. `SettingsDialog` is imported eagerly so the click opens something, and
 * its `Suspense` holds the space the sections land in.
 */
const WorkspaceSettings = lazyRouteComponent(
	() => import("@/screens/WorkspaceSettings.tsx"),
	"WorkspaceSettings",
);

/*
 * The routes, declared rather than generated.
 *
 * A file-based tree would write `routeTree.gen.ts` for us; a hand-built one
 * keeps the shape of the app readable in one screen and adds nothing for CI to
 * regenerate or for Biome to be told to skip. The tree is small and the paths
 * are the product's vocabulary, so it is worth reading:
 *
 *   /                        opens the workspace last visited
 *   /login
 *   /invite/$id
 *   /$workspace/agents       picks the first visible agent
 *   /$workspace/pods/$pod/agents/$agent  chat, using the pod slug and agent handle
 *   /$workspace/settings     workspace settings
 *   /$workspace/settings/pods/$pod/agents/$agent  agent configuration
 *   /$workspace/settings/pods/$pod               pod configuration
 *   /$workspace/settings/built-in-agents/$key    the Scribe or Facilitator
 *   /$workspace/threads/$thread                 one thread
 *
 * Slugs are resolved to records before a page renders: `/$workspace` in its
 * `beforeLoad`, pods and agents in the loaders under it. Each fills the query
 * cache the page's hooks then read, and preloads the page's code alongside, so
 * hovering a link fetches both and a missing record is a `notFound` rather than
 * a branch in every page.
 */

export interface RouterContext {
	session: Session;
	/** The cache the hooks read, so a loader can fill it before its page renders. */
	queryClient: QueryClient;
}

/** What a route under `/$workspace` knows once the workspace in the address resolved. */
interface WorkspaceContext {
	queryClient: QueryClient;
	workspaceId: string;
}

function NothingHere() {
	return (
		<div className="grid h-full place-items-center bg-sunken">
			<EmptyState title="There is nothing at this address">
				The link may be old, or the workspace may have moved on.
			</EmptyState>
		</div>
	);
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
	notFoundComponent: NothingHere,
});

interface LandingSearch {
	/** A connection sign-in that failed before the API knew which pod it was for. */
	oauth_error?: string;
}

const validateLandingSearch = (search: Record<string, unknown>): LandingSearch => ({
	oauth_error: typeof search.oauth_error === "string" ? search.oauth_error : undefined,
});

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	validateSearch: validateLandingSearch,
	beforeLoad: async ({ search, context, location }) => {
		requireUser({ context, location });
		if (search.oauth_error !== undefined) return;
		const workspace = await findWithCachedQueries(context.queryClient, async (readQuery) =>
			rememberedWorkspace(await readQuery(workspacesQuery)),
		);
		if (!workspace) throw redirect({ to: "/onboarding" });
		throw redirect({ to: "/$workspace/agents", params: { workspace: workspace.slug } });
	},
	errorComponent: () => <RetryLoad title="Could not load your workspace" />,
	component: OAuthFailureRoute,
});

function OAuthFailureRoute() {
	const { oauth_error: oauthError } = indexRoute.useSearch();
	return (
		<div className="grid h-full place-items-center bg-sunken p-6">
			<EmptyState title="Connection sign-in failed">
				<p>{oauthError}</p>
				<Link to="/" search={{}} className="text-primary underline">
					Return to workspace
				</Link>
			</EmptyState>
		</div>
	);
}

interface LoginSearch {
	invite?: string;
	/** Where signing in interrupted, as a path in this app; anything else is dropped. */
	returnTo?: string;
}

const validateLoginSearch = (search: Record<string, unknown>): LoginSearch => ({
	invite: typeof search.invite === "string" ? search.invite : undefined,
	returnTo: isAppPath(search.returnTo) ? search.returnTo : undefined,
});

/** A path in this app: not protocol-relative or backslashed, which a browser would take elsewhere. */
function isAppPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.startsWith("/") &&
		!value.startsWith("//") &&
		!value.includes("\\")
	);
}

const loginRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/login",
	validateSearch: validateLoginSearch,
	component: LoginRoute,
});

function LoginRoute() {
	const { session } = loginRoute.useRouteContext();
	const { invite, returnTo } = loginRoute.useSearch();
	const navigate = useNavigate();

	if (session.user) {
		return invite !== undefined ? (
			<Navigate to="/invite/$id" params={{ id: invite }} replace />
		) : (
			<Navigate to={returnTo ?? "/"} replace />
		);
	}

	return (
		<Login
			inviteId={invite}
			onSignedIn={async () => {
				await session.refresh();
				await navigate({
					to: invite !== undefined ? "/invite/$id" : (returnTo ?? "/"),
					params: invite !== undefined ? { id: invite } : undefined,
					replace: true,
				});
			}}
		/>
	);
}

const inviteRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/invite/$id",
	beforeLoad: ({ context, params }) => {
		// An invitation is accepted as somebody. Sign in first, and come back:
		// the id rides along so the link is not lost on the way.
		if (context.session.user === null) {
			throw redirect({ to: "/login", search: { invite: params.id } });
		}
	},
	component: InviteRoute,
});

function InviteRoute() {
	const { session } = inviteRoute.useRouteContext();
	const { id } = inviteRoute.useParams();
	const navigate = useNavigate();

	return (
		<Invite
			id={id}
			onDone={async () => {
				await session.refresh();
				await navigate({ to: "/", replace: true });
			}}
		/>
	);
}

const onboardingRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/onboarding",
	beforeLoad: requireUser,
	component: OnboardingRoute,
});

function OnboardingRoute() {
	const session = onboardingRoute.useRouteContext().session;
	const onboarding = useOnboarding();
	const workspace = useWorkspace();

	if (onboarding.isPending || workspace.isPending) return <div className="h-full bg-sunken" />;
	if (onboarding.error || workspace.error) {
		return (
			<RouteLoadFailure
				title="Could not start setup"
				onRetry={() => Promise.all([onboarding.refetch(), workspace.refetch()])}
			/>
		);
	}
	if (onboarding.data?.completed && workspace.workspace) {
		return (
			<Navigate to="/$workspace/agents" params={{ workspace: workspace.workspace.slug }} replace />
		);
	}
	return <Onboarding session={session} />;
}

/**
 * The frame, for the workspace the address names.
 *
 * An unknown slug is not found, never another workspace: the pods and agents
 * under it would otherwise open in a workspace the link did not name.
 */
const shellRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/$workspace",
	beforeLoad: async ({ context, params, location }) => {
		requireUser({ context, location });
		const workspace = await findWithCachedQueries(context.queryClient, async (readQuery) =>
			(await readQuery(workspacesQuery)).find((one) => one.slug === params.workspace),
		);
		if (!workspace) throw notFound();
		return { workspaceId: workspace.id };
	},
	notFoundComponent: NothingHere,
	errorComponent: () => <RetryLoad title="Could not load your workspace" />,
	component: WorkspaceRoute,
});

function WorkspaceRoute() {
	const { workspace } = shellRoute.useParams();
	return (
		<WorkspaceSlugContext value={workspace}>
			<ShellRoute />
		</WorkspaceSlugContext>
	);
}

const workspaceIndexRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/",
	beforeLoad: ({ params }) => {
		throw redirect({ to: "/$workspace/agents", params });
	},
});

function ShellRoute() {
	const { session, workspaceId } = shellRoute.useRouteContext();
	const onboarding = useOnboarding();

	// Whichever workspace was opened last, by a link or by switching, is the
	// one the landing page goes back to.
	useEffect(() => chooseWorkspace(workspaceId), [workspaceId]);

	if (onboarding.isPending) return <div className="h-full bg-sunken" />;
	if (onboarding.error) {
		return <RouteLoadFailure title="Could not load your workspace" onRetry={onboarding.refetch} />;
	}
	if (!onboarding.data.completed) {
		return <Navigate to="/onboarding" replace />;
	}
	return <Shell session={session} />;
}

function RouteLoadFailure({ title, onRetry }: { title: string; onRetry: () => Promise<unknown> }) {
	return (
		<div className="grid h-full place-items-center bg-sunken p-6">
			<EmptyState title={title}>
				<button type="button" className="text-primary underline" onClick={() => void onRetry()}>
					Try again
				</button>
			</EmptyState>
		</div>
	);
}

/** For a `beforeLoad` or loader that failed: trying again runs them again. */
function RetryLoad({ title }: { title: string }) {
	const router = useRouter();
	return <RouteLoadFailure title={title} onRetry={() => router.invalidate()} />;
}

/** What a page in the frame shows while its loader has not answered. */
function EmptyPanes() {
	return <Panes>{null}</Panes>;
}

function PanesMessage({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<Panes>
			<EmptyState title={title}>{children}</EmptyState>
		</Panes>
	);
}

const API_DID_NOT_ANSWER = "The API did not answer. Reload, or check that it is running.";

/** loadRosters reads pods and agents concurrently. */
async function loadRosters(readQuery: QueryClient["fetchQuery"], workspaceId: string) {
	const [pods, agents] = await Promise.all([
		readQuery(podsQuery(workspaceId)),
		readQuery(agentsQuery(workspaceId)),
	]);
	return { pods, agents };
}

/** Fills the rosters, or is not found when the pod and handle name no agent. */
async function requirePodAgent(context: WorkspaceContext, params: { pod: string; agent: string }) {
	const found = await findWithCachedQueries(context.queryClient, async (readQuery) => {
		const { pods, agents } = await loadRosters(readQuery, context.workspaceId);
		return findPodAgent(pods, agents, params.pod, params.agent);
	});
	if (!found) throw notFound();
}

const settingsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings",
	loader: () => {
		// The dialog opens while its Suspense waits for the settings module.
		void WorkspaceSettings.preload?.();
	},
	component: () => (
		<SettingsDialog>
			<WorkspaceSettings section="general" />
		</SettingsDialog>
	),
});

const settingsSectionRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/$section",
	beforeLoad: ({ params }) => {
		const setting = workspaceSettingSection(params.section);
		if (!setting || setting.id === "general") {
			throw redirect({ to: "/$workspace/settings", params: { workspace: params.workspace } });
		}
		return { settingSection: setting.id };
	},
	loader: () => {
		void WorkspaceSettings.preload?.();
	},
	component: SettingsSectionRoute,
});

function SettingsSectionRoute() {
	const section = settingsSectionRoute.useRouteContext({
		select: (context) => context.settingSection,
	});
	return (
		<SettingsDialog>
			<WorkspaceSettings section={section} />
		</SettingsDialog>
	);
}

const settingsPodAgentRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/pods/$pod/agents/$agent",
	validateSearch: (search: Record<string, unknown>): { tab?: "routines" } =>
		search.tab === "routines" ? { tab: "routines" } : {},
	loader: ({ context, params }) => {
		void WorkspaceSettings.preload?.();
		return requirePodAgent(context, params);
	},
	pendingComponent: EmptyPanes,
	notFoundComponent: () => <PanesMessage title="No such agent in this pod" />,
	errorComponent: () => <PanesMessage title="Could not load this agent" />,
	component: SettingsPodAgentRoute,
});

function SettingsPodAgentRoute() {
	const { pod: podSlug, agent: handle } = settingsPodAgentRoute.useParams();
	const { tab } = settingsPodAgentRoute.useSearch();
	const found = usePodAgent(podSlug, handle);
	// The loader found both, but either can be removed while the page is open.
	if (!found) return <PanesMessage title="No such agent in this pod" />;
	return (
		<SettingsDialog>
			<WorkspaceSettings
				section="pods"
				selectedPodId={found.pod.id}
				selectedAgentId={found.agent.id}
				selectedAgentTab={tab}
			/>
		</SettingsDialog>
	);
}

interface PodSettingsSearch {
	tab?: PodSettingsTab;
	oauth_error?: string;
}

const settingsPodRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/pods/$pod",
	validateSearch: (search: Record<string, unknown>): PodSettingsSearch => ({
		tab: isPodSettingsTab(search.tab) ? search.tab : undefined,
		oauth_error: typeof search.oauth_error === "string" ? search.oauth_error : undefined,
	}),
	remountDeps: ({ params }) => [params.workspace, params.pod],
	loader: async ({ context, params }) => {
		void WorkspaceSettings.preload?.();
		const pod = await findWithCachedQueries(context.queryClient, async (readQuery) =>
			findPod(await readQuery(podsQuery(context.workspaceId)), params.pod),
		);
		if (!pod) throw notFound();
	},
	pendingComponent: EmptyPanes,
	notFoundComponent: () => <PanesMessage title="No such pod here" />,
	errorComponent: () => <PanesMessage title="Could not load this pod" />,
	component: SettingsPodRoute,
});

function SettingsPodRoute() {
	const { pod: podSlug } = settingsPodRoute.useParams();
	const { tab, oauth_error: oauthError } = settingsPodRoute.useSearch();
	const navigate = settingsPodRoute.useNavigate();
	const [connectionSignInError, setConnectionSignInError] = useState(oauthError);
	const { data: pods } = usePods();
	const pod = findPod(pods, podSlug);
	useEffect(() => {
		if (oauthError === undefined) return;
		// Keep the result visible after removing the one-shot callback parameters.
		setConnectionSignInError(oauthError);
		void navigate({
			search: (previous) => ({ ...previous, oauth_error: undefined }),
			replace: true,
		});
	}, [oauthError, navigate]);
	// The loader found it, but it can be removed while the page is open.
	if (!pod) return <PanesMessage title="No such pod here" />;
	return (
		<SettingsDialog>
			<WorkspaceSettings
				section="pods"
				selectedPodId={pod.id}
				selectedPodTab={tab}
				connectionSignInError={connectionSignInError}
			/>
		</SettingsDialog>
	);
}

/**
 * A built-in agent is addressed by its key, not by an id: there is exactly one
 * Scribe and one Facilitator per workspace, so the key is the address, and a
 * screen that links here needs no data to build the link.
 */
const settingsBuiltInAgentRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/built-in-agents/$key",
	beforeLoad: ({ params }) => {
		const { workspace, key } = params;
		if (!isBuiltInAgentKey(key)) {
			throw redirect({
				to: "/$workspace/settings/$section",
				params: { workspace, section: "built-in-agents" },
			});
		}
		return { builtInKey: key };
	},
	loader: () => {
		void WorkspaceSettings.preload?.();
	},
	component: SettingsBuiltInAgentRoute,
});

function SettingsBuiltInAgentRoute() {
	const key = settingsBuiltInAgentRoute.useRouteContext({
		select: (context) => context.builtInKey,
	});
	return (
		<SettingsDialog>
			<WorkspaceSettings section="built-in-agents" selectedBuiltInKey={key} />
		</SettingsDialog>
	);
}

/** Opens the first visible crew agent in the workspace, or says why there is none. */
const agentsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/agents",
	loader: async ({ context }) => {
		const { pods, agents } = await findWithCachedQueries(context.queryClient, (readQuery) =>
			loadRosters(readQuery, context.workspaceId),
		);
		const first = firstCrewAgent(pods, agents);
		if (first) throw redirect(agentChatLink(first));
	},
	pendingComponent: EmptyPanes,
	errorComponent: () => (
		<PanesMessage title="Could not load your agents">{API_DID_NOT_ANSWER}</PanesMessage>
	),
	component: NoAgentsRoute,
});

function NoAgentsRoute() {
	const { data: pods } = usePods();
	const { agents } = useAgents();
	const first = firstCrewAgent(pods, agents);
	if (first) {
		return <Navigate {...agentChatLink(first)} replace />;
	}
	return (
		<PanesMessage title="No agents yet">
			{pods?.length === 0
				? "You are not in a pod yet. An admin can add you to one."
				: "An admin can make the first one."}
		</PanesMessage>
	);
}

interface AgentSearch {
	thread?: string;
	history?: "open";
}

const agentRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/pods/$pod/agents/$agent",
	validateSearch: (search: Record<string, unknown>): AgentSearch => ({
		...(typeof search.thread === "string" ? { thread: search.thread } : {}),
		...(search.history === "open" ? { history: "open" as const } : {}),
	}),
	loader: ({ context, params }) =>
		Promise.all([requirePodAgent(context, params), AgentPage.preload?.()]),
	pendingComponent: EmptyPanes,
	notFoundComponent: NoSuchAgent,
	errorComponent: () => (
		<PanesMessage title="Could not load this agent">{API_DID_NOT_ANSWER}</PanesMessage>
	),
	component: AgentRoute,
});

function NoSuchAgent() {
	return (
		<PanesMessage title="No such agent here">
			It may have been removed, or renamed — or you may not be a member of any pod it is in.
		</PanesMessage>
	);
}

function AgentRoute() {
	const { pod: podSlug, agent: handle } = agentRoute.useParams();
	const search = agentRoute.useSearch();
	const { user } = agentRoute.useRouteContext().session;
	const found = usePodAgent(podSlug, handle);

	// The loader found both, but either can be removed while the page is open.
	if (!found) return <NoSuchAgent />;
	if (!user) return null;
	return (
		<Panes>
			<AgentPage
				agent={found.agent}
				pod={found.pod}
				user={user}
				threadId={search.thread}
				historyOpen={search.history === "open"}
			/>
		</Panes>
	);
}

const threadRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/threads/$thread",
	validateSearch: (search: Record<string, unknown>) => ({
		summary: search.summary === "closed" ? ("closed" as const) : undefined,
	}),
	loader: () => ThreadPage.preload?.(),
	component: ThreadRoute,
});

function ThreadRoute() {
	const { thread } = threadRoute.useParams();
	const { user } = threadRoute.useRouteContext().session;
	if (!user) {
		return null;
	}
	return (
		<Panes>
			<ThreadPage key={thread} threadId={thread} user={user} />
		</Panes>
	);
}

/**
 * Signed out means the login page, which comes back here once signed in.
 * `undefined` cannot reach here: `main.tsx` waits for `/me` to answer before
 * it mounts the router at all.
 */
function requireUser({
	context,
	location,
}: {
	context: RouterContext;
	location: { href: string };
}): void {
	if (context.session.user === null) {
		throw redirect({ to: "/login", search: { returnTo: location.href } });
	}
}

const routeTree = rootRoute.addChildren([
	indexRoute,
	loginRoute,
	inviteRoute,
	onboardingRoute,
	shellRoute.addChildren([
		workspaceIndexRoute,
		settingsRoute,
		settingsSectionRoute,
		settingsPodAgentRoute,
		settingsPodRoute,
		settingsBuiltInAgentRoute,
		agentsRoute,
		agentRoute,
		threadRoute,
	]),
]);

export function createAppRouter(options?: { history?: RouterHistory }) {
	return createRouter({
		routeTree,
		// Supplied by `RouterProvider` once the session is known.
		context: undefined as unknown as RouterContext,
		defaultPreload: "intent",
		// The query cache decides when data is stale, which it can only do if
		// the router asks the loaders every time rather than reusing their last answer.
		defaultPreloadStaleTime: 0,
		// Tests mount the real tree over a memory history, so a route's guards
		// and search params are exercised rather than mocked around.
		...options,
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>;
	}
}

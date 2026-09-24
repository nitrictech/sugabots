import { CONNECTION_SIGN_IN_RETURN_PATH } from "@sugabots/contracts";
import { useQuery } from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import {
	createRootRouteWithContext,
	createRoute,
	createRouter,
	Link,
	lazyRouteComponent,
	Navigate,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { useAgent, useAgents } from "@/lib/agents.ts";
import { isBuiltInAgentKey } from "@/lib/built-in-agents.ts";
import { agentChatLink } from "@/lib/links.ts";
import { useOnboarding } from "@/lib/onboarding.ts";
import { podsQuery, usePods } from "@/lib/pods.ts";
import type { Session } from "@/lib/session.ts";
import { useWorkspace, useWorkspaces } from "@/lib/workspace.ts";
import { workspaceSettingSection } from "@/lib/workspace-settings.ts";
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
 *   /                        opens the workspace last chosen
 *   /login
 *   /invite/$id
 *   /connections/oauth/return        where a connection's sign-in comes back
 *   /$workspace/settings     workspace settings
 *   /$workspace/agents       picks the first agent you can see
 *   /$workspace/agents/$agent        one agent's thread history and new-thread composer
 *   /$workspace/settings/pods/$pod   workspace pod detail
 *   /$workspace/settings/built-in-agents/$key   the Scribe or the Facilitator
 *   /$workspace/threads/$thread      one thread
 *
 * A pod is a property of a thread and not a segment of its address: an agent
 * may be in several pods, and a thread is already in exactly one, so putting
 * the pod in the path would only give the same thread two addresses.
 *
 * An agent is addressed by its id rather than a slug, because it has no slug:
 * a person renames an agent the way they rename a colleague's nickname, and
 * every link to it would break.
 *
 */

export interface RouterContext {
	session: Session;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
	notFoundComponent: () => (
		<div className="grid h-full place-items-center bg-sunken">
			<EmptyState title="There is nothing at this address">
				The link may be old, or the workspace may have moved on.
			</EmptyState>
		</div>
	),
});

/** `?invite=` from the invitations NIT-1758 sent before there was a route. */
interface RootSearch {
	invite?: string;
}

const validateInviteSearch = (search: Record<string, unknown>): RootSearch => ({
	invite: typeof search.invite === "string" ? search.invite : undefined,
});

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	validateSearch: validateInviteSearch,
	beforeLoad: ({ search, context }) => {
		// Invitation links already in inboxes and docker logs point at `/?invite=`.
		// They keep working: the route is the new shape, this is the old one.
		if (search.invite !== undefined) {
			throw redirect({ to: "/invite/$id", params: { id: search.invite } });
		}
		requireUser({ context });
	},
	component: LandingRoute,
});

function LandingRoute() {
	const { workspace, isPending, error, refetch } = useWorkspace();
	if (isPending) return <div className="h-full bg-sunken" />;
	if (error) return <RouteLoadFailure title="Could not load your workspace" onRetry={refetch} />;
	if (!workspace) return <Navigate to="/onboarding" replace />;
	return <Navigate to="/$workspace/agents" params={{ workspace: workspace.slug }} replace />;
}

const loginRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/login",
	validateSearch: validateInviteSearch,
	component: LoginRoute,
});

function LoginRoute() {
	const { session } = loginRoute.useRouteContext();
	const { invite } = loginRoute.useSearch();
	const navigate = useNavigate();

	if (session.user) {
		return invite !== undefined ? (
			<Navigate to="/invite/$id" params={{ id: invite }} replace />
		) : (
			<Navigate to="/" replace />
		);
	}

	return (
		<Login
			inviteId={invite}
			onSignedIn={async () => {
				await session.refresh();
				await navigate({
					to: invite !== undefined ? "/invite/$id" : "/",
					params: invite !== undefined ? { id: invite } : undefined,
					replace: true,
				});
			}}
		/>
	);
}

interface SignInReturnSearch {
	workspace?: string;
	pod?: string;
	connected?: string;
	oauth_error?: string;
}

const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);

/** Where a connection's OAuth sign-in returns. The API sends ids; this picks the page. */
const signInReturnRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: CONNECTION_SIGN_IN_RETURN_PATH,
	validateSearch: (search: Record<string, unknown>): SignInReturnSearch => ({
		workspace: optionalString(search.workspace),
		pod: optionalString(search.pod),
		connected: optionalString(search.connected),
		oauth_error: optionalString(search.oauth_error),
	}),
	beforeLoad: requireUser,
	component: SignInReturnRoute,
});

function SignInReturnRoute() {
	const {
		workspace,
		pod: podId,
		connected,
		oauth_error: oauthError,
	} = signInReturnRoute.useSearch();
	const workspaces = useWorkspaces();
	const slug = workspaces.data?.find((one) => one.id === workspace)?.slug;
	const pods = useQuery(podsQuery(workspace));
	const pod = pods.data?.find((one) => one.id === podId);
	const navigate = useNavigate();

	useEffect(() => {
		if (!pod || !slug) return;
		// Outside any workspace, so this names one; the link helpers are for pages inside.
		void navigate({
			to: "/$workspace/settings/pods/$pod",
			params: { workspace: slug, pod: pod.id },
			search: { connected, oauth_error: oauthError },
			replace: true,
		});
	}, [pod, slug, connected, oauthError, navigate]);

	const resolving = workspace !== undefined && (pods.isPending || workspaces.isPending);
	if ((pod && slug) || resolving) {
		return <div className="h-full bg-sunken" />;
	}
	return (
		<div className="grid h-full place-items-center bg-sunken p-6">
			<EmptyState title="Connection sign-in failed">
				<p>{oauthError ?? "The pod it was for is no longer available to you."}</p>
				<Link to="/" className="text-primary underline">
					Return to workspace
				</Link>
			</EmptyState>
		</div>
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

/** The frame, for the workspace the address names. */
const shellRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/$workspace",
	beforeLoad: requireUser,
	component: ShellRoute,
});

const workspaceIndexRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/",
	beforeLoad: ({ params }) => {
		throw redirect({ to: "/$workspace/agents", params });
	},
});

function ShellRoute() {
	const session = shellRoute.useRouteContext().session;
	const onboarding = useOnboarding();
	const workspace = useWorkspace();
	const workspaces = useWorkspaces();

	if (onboarding.isPending || workspace.isPending) return <div className="h-full bg-sunken" />;
	if (onboarding.error || workspace.error) {
		return (
			<RouteLoadFailure
				title="Could not load your workspace"
				onRetry={() => Promise.all([onboarding.refetch(), workspace.refetch()])}
			/>
		);
	}
	if (!workspace.workspace) {
		// Somebody in no workspace at all has one to make, not a wrong address.
		return workspaces.data?.length === 0 ? (
			<Navigate to="/onboarding" replace />
		) : (
			<EmptyState title="No such workspace here" />
		);
	}
	if (!onboarding.data?.completed) {
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

const settingsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings",
	component: () => (
		<SettingsDialog>
			<WorkspaceSettings section="general" />
		</SettingsDialog>
	),
});

const settingsSectionRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/$section",
	component: SettingsSectionRoute,
});

const settingsPodAgentRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/pods/$pod/agents/$agent",
	validateSearch: (search: Record<string, unknown>): { tab?: "routines" } =>
		search.tab === "routines" ? { tab: "routines" } : {},
	component: SettingsPodAgentRoute,
});

const settingsPodRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/pods/$pod",
	// Kept in the address until the Connections panel reads and clears them.
	validateSearch: (
		search: Record<string, unknown>,
	): { connected?: string; oauth_error?: string } => ({
		connected: optionalString(search.connected),
		oauth_error: optionalString(search.oauth_error),
	}),
	component: SettingsPodRoute,
});

/**
 * A built-in agent is addressed by its key, not by an id: there is exactly one
 * Scribe and one Facilitator per workspace, so the key is the address, and a
 * screen that links here needs no data to build the link.
 */
const settingsBuiltInAgentRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/built-in-agents/$key",
	component: SettingsBuiltInAgentRoute,
});

function SettingsBuiltInAgentRoute() {
	const { key } = settingsBuiltInAgentRoute.useParams();
	if (!isBuiltInAgentKey(key)) {
		return (
			<Navigate
				from="/$workspace"
				to="./settings/$section"
				params={{ section: "built-in-agents" }}
				replace
			/>
		);
	}
	return (
		<SettingsDialog>
			<WorkspaceSettings section="built-in-agents" selectedBuiltInKey={key} />
		</SettingsDialog>
	);
}

function SettingsPodRoute() {
	const { pod: podId } = settingsPodRoute.useParams();
	return (
		<SettingsDialog>
			<WorkspaceSettings section="pods" selectedPodId={podId} />
		</SettingsDialog>
	);
}

function SettingsPodAgentRoute() {
	const { pod, agent } = settingsPodAgentRoute.useParams();
	const { tab } = settingsPodAgentRoute.useSearch();
	return (
		<SettingsDialog>
			<WorkspaceSettings
				section="pods"
				selectedPodId={pod}
				selectedAgentId={agent}
				selectedAgentTab={tab}
			/>
		</SettingsDialog>
	);
}

function SettingsSectionRoute() {
	const { section } = settingsSectionRoute.useParams();
	const setting = workspaceSettingSection(section);
	if (!setting || setting.id === "general") {
		return <Navigate from="/$workspace" to="./settings" replace />;
	}
	return (
		<SettingsDialog>
			<WorkspaceSettings section={setting.id} />
		</SettingsDialog>
	);
}

/** Picks the first crew agent the caller can see. `/` sends everybody here. */
const agentsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/agents",
	component: AgentsRoute,
});

function AgentsRoute() {
	const { data: pods, isPending: podsPending, error: podsError } = usePods();
	const { agents, isPending, error } = useAgents();
	// The roster is crew only, and this states why it has to stay that way:
	// nobody talks to a built-in agent, so none may be landed on.
	const first = agents?.find((agent) => agent.systemAgentKey === null);
	const firstPod = pods?.find((pod) => pod.id === first?.podId);

	if (podsPending || isPending) {
		return <Panes>{null}</Panes>;
	}

	if (first && firstPod) {
		return <Navigate {...agentChatLink({ pod: firstPod, agent: first })} replace />;
	}

	return (
		<Panes>
			<EmptyState title={podsError || error ? "Could not load your agents" : "No agents yet"}>
				{podsError || error
					? "The API did not answer. Reload, or check that it is running."
					: pods?.length === 0
						? "You are not in a pod yet. An admin can add you to one."
						: "An admin can make the first one."}
			</EmptyState>
		</Panes>
	);
}

interface AgentSearch {
	pod?: string;
	thread?: string;
	history?: "open";
}

const agentRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/agents/$agent",
	validateSearch: (search: Record<string, unknown>): AgentSearch => ({
		...(typeof search.pod === "string" ? { pod: search.pod } : {}),
		...(typeof search.thread === "string" ? { thread: search.thread } : {}),
		...(search.history === "open" ? { history: "open" as const } : {}),
	}),
	component: AgentRoute,
});

function AgentRoute() {
	const { agent: agentId } = agentRoute.useParams();
	const search = agentRoute.useSearch();
	const { user } = agentRoute.useRouteContext().session;
	const { agent, isPending, error } = useAgent(agentId);

	if (isPending) {
		return <Panes>{null}</Panes>;
	}
	if (!agent) {
		return (
			<Panes>
				<EmptyState title={error ? "Could not load this agent" : "No such agent here"}>
					{error
						? "The API did not answer. Reload, or check that it is running."
						: "It may have been removed, or renamed — or you may not be a member of any pod it is in."}
				</EmptyState>
			</Panes>
		);
	}

	if (!user) return null;
	return (
		<Panes>
			<AgentPage
				agent={agent}
				requestedPodId={search.pod}
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
 * Signed out means the login page. `undefined` cannot reach here: `main.tsx`
 * waits for `/me` to answer before it mounts the router at all.
 */
function requireUser({ context }: { context: RouterContext }): void {
	if (context.session.user === null) {
		throw redirect({ to: "/login" });
	}
}

const routeTree = rootRoute.addChildren([
	indexRoute,
	loginRoute,
	inviteRoute,
	signInReturnRoute,
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

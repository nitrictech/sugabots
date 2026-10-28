import type { Agent, Pod, SessionUser, Workspace, WorkspacePermissions } from "@sugabots/contracts";
import {
	CONNECTION_SIGN_IN_RETURN_PATH,
	GITHUB_SETUP_RETURN_PATH,
	type GitHubSetupFailure,
} from "@sugabots/contracts";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ParsedLocation, RouterHistory } from "@tanstack/react-router";
import {
	createRootRouteWithContext,
	createRoute,
	createRouter,
	Link,
	Navigate,
	Outlet,
	RouterProvider,
	redirect,
	useMatchRoute,
	useNavigate,
	useParams,
	useRouter,
} from "@tanstack/react-router";
import { type ComponentType, lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { validate as isUuid } from "uuid";
import { usePodAgent } from "@/lib/agents.ts";
import {
	type ConversationPlace,
	prefetchConversation,
	useChatList,
	useConversationPlace,
	useOpenBotChannel,
	useOpenPodChat,
	useOpenRoutineFeed,
} from "@/lib/chats.ts";
import { signInFailureReason } from "@/lib/connections.ts";
import { conversationLink, podChatLink, podLink, routineThreadLink } from "@/lib/links.ts";
import { matchesMedia, SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { RESET_PASSWORD_PATH } from "@/lib/password-reset.ts";
import { defaultPod, findPod, podsQuery, usePods } from "@/lib/pods.ts";
import { type Session, SessionContext, useSession } from "@/lib/session.ts";
import {
	chooseWorkspace,
	useDeleteWorkspace,
	useWorkspace,
	useWorkspaceStanding,
	useWorkspaces,
} from "@/lib/workspace.ts";
import { workspaceSettingSection } from "@/lib/workspace-settings.ts";
import { ApprovalPage } from "@/screens/ApprovalPage.tsx";
import { ArtifactsPage } from "@/screens/Artifacts.tsx";
import type { Staged } from "@/screens/ConversationChat.tsx";
import { SettingsLayout } from "@/screens/SettingsLayout.tsx";
import { Approvals } from "@/shell/Approvals.tsx";
import { Inbox, InboxOverview } from "@/shell/Inbox.tsx";
import { PageFailure } from "@/shell/PageFailure.tsx";
import { RoutinesPage } from "@/shell/Routines.tsx";
import { Panes, Shell } from "@/shell/Shell.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";

const ConversationPage = lazyNamed(
	() => import("@/screens/ConversationPage.tsx"),
	"ConversationPage",
);
const NewThread = lazyNamed(() => import("@/screens/NewThread.tsx"), "NewThread");
const ActivityPane = lazyNamed(() => import("@/screens/ActivityPane.tsx"), "ActivityPane");
const Invite = lazyNamed(() => import("@/screens/Invite.tsx"), "Invite");
const Login = lazyNamed(() => import("@/screens/Login.tsx"), "Login");
const ResetPassword = lazyNamed(
	// Only this export: the module's other screen would otherwise decide the props.
	() => import("@/screens/ResetPassword.tsx").then(({ ResetPassword }) => ({ ResetPassword })),
	"ResetPassword",
);
const Onboarding = lazyNamed(() => import("@/screens/Onboarding.tsx"), "Onboarding");
/*
 * The settings sections are a chunk of their own; the window they open in is
 * not. `SettingsDialog` is imported eagerly so the click opens something, and
 * its `Suspense` holds the space the sections land in.
 */
const WorkspaceSettings = lazyNamed(
	() => import("@/screens/WorkspaceSettings.tsx"),
	"WorkspaceSettings",
);

/**
 * A screen's named export as a component that loads its module on first render,
 * with `preload` to start the load sooner. Both share one load; a failed preload
 * is forgotten, so opening the screen fetches again.
 *
 * Once the module is here, the screen renders without suspending: `lazy` alone
 * would suspend once even then, and hold the screen behind React's 300ms reveal throttle.
 *
 * TanStack Router's `lazyRouteComponent` is not used because it calls `use()`
 * only while the module is still loading, and React 19.3 reports a render that
 * suspends on `use()` and then finishes without calling it as an error.
 */
function lazyNamed<Name extends string, Props extends object>(
	load: () => Promise<Record<Name, ComponentType<Props>>>,
	name: Name,
) {
	let loading: Promise<{ default: ComponentType<Props> }> | undefined;
	let loaded: ComponentType<Props> | undefined;
	const loadScreenModule = () => {
		loading ??= load().then(
			(module) => {
				loaded = module[name];
				return { default: loaded };
			},
			(error: unknown) => {
				loading = undefined;
				throw error;
			},
		);
		return loading;
	};
	const Lazy = lazy(loadScreenModule);
	function Screen(props: Props) {
		// Chosen once per mount: swapping `Lazy` for the loaded component would remount the screen.
		const [Component] = useState<ComponentType<Props>>(() => loaded ?? Lazy);
		return <Component {...props} />;
	}
	Screen.displayName = name;
	const preload = () => {
		loadScreenModule().catch(() => {});
	};
	return Object.assign(Screen, { preload });
}

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
 *   /reset-password           where a password reset email's link lands
 *   /join/$code               where a referral link lands
 *   /invite/$id
 *   /connections/oauth/return        where a connection's sign-in comes back
 *   /$workspace/settings     workspace settings
 *   /$workspace/agents       lands on the first shared pod, or on Personal when there is none
 *   /$workspace/activity     what is new across the workspace: mentions, unread messages, routine runs and collaborations
 *   /$workspace/activity/$pod/$conversation   the conversation, run or collaboration of the one chosen, beside them
 *   /$workspace/approvals    every approval across the workspace
 *   /$workspace/approvals/$call   one of them in full, by its tool call's id
 *   /$workspace/pods/$pod    one pod's conversation list
 *   /$workspace/pods/$pod/chat               the pod's chat, opened first if nobody has
 *   /$workspace/pods/$pod/routines/$routine  a routine's own thread, opened first if it has none
 *   /$workspace/pods/$pod/threads/new         starting a thread from its first message
 *   /$workspace/pods/$pod/threads/$conversation   one conversation, by pod slug and its id
 *   /$workspace/pods/$pod/agents/$agent       an agent's newest conversation, started if it has none
 *   /$workspace/settings/members/$member   one person, by membership id
 *   /$workspace/settings/pods/$pod   workspace pod detail
 *   /$workspace/settings/pods/$pod/agents/$agent   agent configuration
 *   /$workspace/settings/pods/$pod/connections/$connection   one connection, by id
 *   /$workspace/settings/providers/$provider   one model provider
 *   /$workspace/settings/providers/default  the model new bots start on
 *   /$workspace/settings/providers/system   the model the system bots use
 *   /$workspace/settings/routines/$routine   one routine, by id
 *   /$workspace/settings/routines/new   a routine being made, for `?agent=` when one is chosen
 *
 * An agent's address names its pod, because a handle is unique only within
 * one, and uses the handle rather than the name, so renaming an agent keeps
 * its links. A collaboration or routine run has no address of its own: it
 * opens beside its bot's chat, as `?thread=`.
 */

/**
 * What the route guards and loaders read. A route takes its context when it loads, so a
 * component reading it would not see you change, as when you rename yourself,
 * until the next navigation: components read the session with `useSession()`.
 */
export interface RouterContext {
	user: Session["user"];
	/** The session's query cache, which loaders prime for the page they lead to. */
	queries: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
	notFoundComponent: () => (
		<div className="grid h-full place-items-center bg-list">
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
	beforeLoad: (options) => {
		// Invitation links already in inboxes and docker logs point at `/?invite=`.
		// They keep working: the route is the new shape, this is the old one.
		if (options.search.invite !== undefined) {
			throw redirect({ to: "/invite/$id", params: { id: options.search.invite } });
		}
		requireUser(options);
	},
	loader: preloadChatScreenForWideLayout,
	component: LandingRoute,
});

/**
 * Opens the chosen workspace, unless that would take the caller into its setup
 * and another is set up. One left part way then opens when asked for by its
 * address or the switcher, or here when there is no other.
 */
function LandingRoute() {
	const { workspace: chosen, isPending, error, refetch } = useWorkspace();
	const workspaces = useWorkspaces();
	const standing = useWorkspaceStanding();
	if (isPending) return <div className="h-full bg-list" />;
	if (error) return <RouteLoadFailure title="Could not load your workspace" onRetry={refetch} />;
	if (!chosen) return <Navigate to="/onboarding" replace />;
	if (chosen.setupCompletedAt === null && standing.isPending) {
		return <div className="h-full bg-list" />;
	}
	const setUp = workspaces.data?.find((one) => one.setupCompletedAt !== null);
	const landing = setUp && opensIntoSetup(chosen, standing.data?.permissions) ? setUp : chosen;
	return <Navigate to="/$workspace/agents" params={{ workspace: landing.slug }} replace />;
}

interface LoginSearch {
	invite?: string;
	/** Set on the way back from a password reset. */
	passwordChanged?: boolean;
	/** Where signing in interrupted, as a path in this app; anything else is dropped. */
	returnTo?: string;
}

const loginRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/login",
	validateSearch: (search: Record<string, unknown>): LoginSearch => ({
		...validateInviteSearch(search),
		passwordChanged: search.passwordChanged === true ? true : undefined,
		returnTo: isAppPath(search.returnTo) ? search.returnTo : undefined,
	}),
	component: LoginRoute,
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

function LoginRoute() {
	const session = useSession();
	const { invite, passwordChanged, returnTo = "/" } = loginRoute.useSearch();
	const navigate = useNavigate();

	if (session.user) {
		return invite !== undefined ? (
			<Navigate to="/invite/$id" params={{ id: invite }} replace />
		) : (
			<Navigate to={returnTo} replace />
		);
	}

	return (
		<Login
			inviteId={invite}
			passwordChanged={passwordChanged}
			onSignedIn={async () => {
				await session.refresh();
				await navigate({
					to: invite !== undefined ? "/invite/$id" : returnTo,
					params: invite !== undefined ? { id: invite } : undefined,
					replace: true,
				});
			}}
		/>
	);
}

/** `$code` is from a member's referral link; the API decides whether it still works. */
const joinRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/join/$code",
	component: JoinRoute,
});

/** Signing up from a referral link. Somebody already signed in has no use for it and goes home. */
function JoinRoute() {
	const session = useSession();
	const { code } = joinRoute.useParams();
	const navigate = useNavigate();

	if (session.user) return <Navigate to="/" replace />;

	return (
		<Login
			referralCode={code}
			onSignedIn={async () => {
				await session.refresh();
				await navigate({ to: "/", replace: true });
			}}
		/>
	);
}

interface ResetPasswordSearch {
	/** From a link the API has checked; absent with `error` once it has expired or been used. */
	token?: string;
}

const resetPasswordRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: RESET_PASSWORD_PATH,
	validateSearch: (search: Record<string, unknown>): ResetPasswordSearch => ({
		token: optionalString(search.token),
	}),
	component: ResetPasswordRoute,
});

function ResetPasswordRoute() {
	const session = useSession();
	const { token } = resetPasswordRoute.useSearch();
	const navigate = useNavigate();
	const toLogin = (search: LoginSearch) => navigate({ to: "/login", search, replace: true });

	return (
		<ResetPassword
			token={token}
			onBack={() => toLogin({})}
			onReset={async () => {
				// The reset ended every session, this browser's included.
				await session.refresh();
				await toLogin({ passwordChanged: true });
			}}
		/>
	);
}

interface SignInReturnSearch {
	workspace?: string;
	pod?: string;
	/** A code saying why the sign-in did not finish, shown only through `signInFailureReason`. */
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
		oauth_error: optionalString(search.oauth_error),
	}),
	beforeLoad: requireUser,
	component: SignInReturnRoute,
});

function SignInReturnRoute() {
	const { workspace, pod: podId, oauth_error: oauthError } = signInReturnRoute.useSearch();
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
			params: { workspace: slug, pod: pod.slug },
			search: { oauth_error: oauthError },
			replace: true,
		});
	}, [pod, slug, oauthError, navigate]);

	const resolving = workspace !== undefined && (pods.isPending || workspaces.isPending);
	if ((pod && slug) || resolving) {
		return <div className="h-full bg-list" />;
	}
	return (
		<div className="grid h-full place-items-center bg-list p-6">
			<EmptyState title="Connection sign-in failed">
				<p>
					{oauthError
						? signInFailureReason(oauthError)
						: "The pod it was for is no longer available to you."}
				</p>
				<Link to="/" className="text-link underline">
					Return to workspace
				</Link>
			</EmptyState>
		</div>
	);
}

/**
 * Where a pod's GitHub setup returns: the API names the pod, its GitHub
 * connection once GitHub made its app, and why setup stopped when it did.
 */
const gitHubSetupReturnRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: GITHUB_SETUP_RETURN_PATH,
	validateSearch: (search: Record<string, unknown>) => ({
		workspace: optionalString(search.workspace),
		pod: optionalString(search.pod),
		connection: optionalString(search.connection),
		github_error: optionalString(search.github_error),
	}),
	beforeLoad: requireUser,
	component: GitHubSetupReturnRoute,
});

function GitHubSetupReturnRoute() {
	const {
		workspace,
		pod: podId,
		connection,
		github_error: failure,
	} = gitHubSetupReturnRoute.useSearch();
	const workspaces = useWorkspaces();
	const slug = workspaces.data?.find((one) => one.id === workspace)?.slug;
	const pods = useQuery(podsQuery(workspace));
	const pod = pods.data?.find((one) => one.id === podId);
	const navigate = useNavigate();

	useEffect(() => {
		if (failure || !slug || !pod || !connection) return;
		// Outside any workspace, so this names one; the link helpers are for pages inside.
		void navigate({
			to: "/$workspace/settings/pods/$pod/connections/$connection",
			params: { workspace: slug, pod: pod.slug, connection },
			replace: true,
		});
	}, [failure, slug, pod, connection, navigate]);

	const resolving = workspace !== undefined && (pods.isPending || workspaces.isPending);
	if ((!failure && slug && pod && connection) || resolving) {
		return <div className="h-full bg-list" />;
	}
	return (
		<div className="grid h-full place-items-center bg-list p-6">
			<EmptyState title="GitHub setup didn't finish">
				<p>{gitHubSetupFailureReason(failure)}</p>
				{slug && pod ? (
					<Link
						to="/$workspace/settings/pods/$pod"
						params={{ workspace: slug, pod: pod.slug }}
						className="text-link underline"
					>
						Back to {pod.name}
					</Link>
				) : (
					<Link to="/" className="text-link underline">
						Return to workspace
					</Link>
				)}
			</EmptyState>
		</div>
	);
}

const GITHUB_SETUP_FAILURES: Record<GitHubSetupFailure, string> = {
	expired:
		"The link had expired, or was started by someone else. Start again from the pod's connections.",
	github: "GitHub refused or couldn't be reached. Try again in a moment.",
	cancelled:
		"It was cancelled on GitHub. Start again from the pod's connections when you're ready.",
};

function gitHubSetupFailureReason(failure: string | undefined) {
	return failure && failure in GITHUB_SETUP_FAILURES
		? GITHUB_SETUP_FAILURES[failure as GitHubSetupFailure]
		: "The pod it was for is no longer available to you.";
}

const inviteRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/invite/$id",
	beforeLoad: ({ context, params }) => {
		// An invitation is accepted as somebody. Sign in first, and come back:
		// the id rides along so the link is not lost on the way.
		if (context.user === null) {
			throw redirect({ to: "/login", search: { invite: params.id } });
		}
	},
	component: InviteRoute,
});

function InviteRoute() {
	const session = useSession();
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

interface OnboardingSearch {
	/**
	 * The workspace being set up, by its address. Written before the workspace
	 * is saved, so a reload while it saves picks up where it got to.
	 */
	workspace?: string;
}

/**
 * Setting up a workspace, the first or another, all at this one path: every
 * top-level path hides the workspace whose address matches it.
 */
const onboardingRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/onboarding",
	validateSearch: (search: Record<string, unknown>): OnboardingSearch => ({
		workspace: typeof search.workspace === "string" ? search.workspace : undefined,
	}),
	beforeLoad: requireUser,
	component: OnboardingRoute,
});

function OnboardingRoute() {
	const session = useSession();
	const { workspace: madeSlug } = onboardingRoute.useSearch();
	const { isPending, error, refetch } = useWorkspace();
	const workspaces = useWorkspaces();

	if (isPending) return <div className="h-full bg-list" />;
	if (error) return <RouteLoadFailure title="Could not start setup" onRetry={refetch} />;
	return (
		<WorkspaceSetup
			session={session}
			made={workspaces.data?.find((one) => one.slug === madeSlug)}
		/>
	);
}

/**
 * Cancel chooses the workspace setup was opened from, or another when that is
 * the one being set up, and goes back to the page it was opened on. Without
 * one there is nowhere to go back to, and no Cancel.
 *
 * Cancel deletes the workspace being set up while its setup is unfinished, if
 * the caller may delete it, as its owner may. One whose setup is finished stays.
 */
function WorkspaceSetup({ session, made }: { session: Session; made: Workspace | undefined }) {
	const router = useRouter();
	const openedFrom = useWorkspace().workspace;
	const workspaces = useWorkspaces().data;
	// Settled when setup opens, because making the workspace chooses it.
	const [returnTo] = useState(() =>
		openedFrom && openedFrom.id !== made?.id
			? openedFrom
			: workspaces?.find((one) => one.id !== made?.id),
	);
	const deleteWorkspace = useDeleteWorkspace();
	// Setup shows its steps only once the workspace being set up is chosen, so this is its standing.
	const standing = useWorkspaceStanding();

	async function cancel() {
		if (made?.setupCompletedAt === null && standing.data?.permissions.deleteWorkspace) {
			// One that cannot be deleted now stays; leaving still goes ahead.
			await deleteWorkspace.mutateAsync(made.id).catch(() => undefined);
		}
		if (returnTo) chooseWorkspace(returnTo.id);
		if (router.history.canGoBack()) router.history.back();
		else void router.navigate({ to: "/" });
	}

	return (
		<Onboarding
			session={session}
			workspace={made}
			onAddress={(slug) =>
				void router.navigate({ to: "/onboarding", search: { workspace: slug }, replace: true })
			}
			onCancel={returnTo ? () => void cancel() : undefined}
		/>
	);
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
	const workspace = useWorkspace();
	const workspaces = useWorkspaces();
	const standing = useWorkspaceStanding();

	if (workspace.isPending) return <div className="h-full bg-list" />;
	if (workspace.error) {
		return <RouteLoadFailure title="Could not load your workspace" onRetry={workspace.refetch} />;
	}
	if (!workspace.workspace) {
		// Somebody in no workspace at all has one to make, not a wrong address.
		return workspaces.data?.length === 0 ? (
			<Navigate to="/onboarding" replace />
		) : (
			<EmptyState title="No such workspace here" />
		);
	}
	if (workspace.workspace.setupCompletedAt === null) {
		// Setup left part way is finished before the workspace is used, by whoever may finish it.
		// Anybody invited part way through uses it as it is.
		if (standing.isPending) return <div className="h-full bg-list" />;
		if (standing.error) {
			return <RouteLoadFailure title="Could not load your workspace" onRetry={standing.refetch} />;
		}
		if (opensIntoSetup(workspace.workspace, standing.data?.permissions)) {
			return <Navigate to="/onboarding" search={{ workspace: workspace.workspace.slug }} replace />;
		}
	}
	return <Shell />;
}

/**
 * Whether opening `workspace` takes the caller into its setup instead: it is
 * still being set up, and they may finish it, which takes
 * `workspace.providers.manage`.
 */
function opensIntoSetup(
	workspace: Workspace,
	permissions: WorkspacePermissions | undefined,
): boolean {
	return workspace.setupCompletedAt === null && permissions?.manageProviders === true;
}

function RouteLoadFailure({ title, onRetry }: { title: string; onRetry: () => Promise<unknown> }) {
	return (
		<div className="grid h-full place-items-center bg-list p-6">
			<EmptyState title={title}>
				<Button variant="outline" onClick={() => void onRetry()}>
					Try again
				</Button>
			</EmptyState>
		</div>
	);
}

const settingsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings",
	// General on a wide screen; on a phone, the list of sections to drill into.
	component: () => (
		<SettingsLayout index>
			<WorkspaceSettings section="general" />
		</SettingsLayout>
	),
});

const settingsSectionRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/$section",
	component: SettingsSectionRoute,
});

/** One person in the workspace, by their membership's id. */
const settingsMemberRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/members/$member",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsMemberRoute,
});

function SettingsMemberRoute() {
	const { member } = settingsMemberRoute.useParams();
	return (
		<SettingsLayout>
			<WorkspaceSettings section="members" selectedMemberId={member} />
		</SettingsLayout>
	);
}

const settingsPodAgentRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/pods/$pod/agents/$agent",
	// The dialog waits for the rosters, so its code downloads alongside rather than after.
	loader: () => WorkspaceSettings.preload(),
	component: SettingsPodAgentRoute,
});

const settingsPodRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/pods/$pod",
	validateSearch: (search: Record<string, unknown>): { oauth_error?: string } => ({
		oauth_error: optionalString(search.oauth_error),
	}),
	// A sign-in error shown for one pod must not follow you to the next.
	remountDeps: ({ params }) => [params.workspace, params.pod],
	loader: () => WorkspaceSettings.preload(),
	component: SettingsPodRoute,
});

/** One of a pod's connections, by its id. */
const settingsPodConnectionRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/pods/$pod/connections/$connection",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsPodConnectionRoute,
});

/** One routine, by its id. */
const settingsRoutineRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/routines/$routine",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsRoutineRoute,
});

function SettingsRoutineRoute() {
	const { routine } = settingsRoutineRoute.useParams();
	return (
		<SettingsLayout>
			<WorkspaceSettings section="routines" selectedRoutineId={routine} />
		</SettingsLayout>
	);
}

/** A routine being made, for the bot `?agent=` names when it was started from that bot. */
const settingsNewRoutineRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/routines/new",
	validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
		agent: optionalString(search.agent),
	}),
	loader: () => WorkspaceSettings.preload(),
	component: SettingsNewRoutineRoute,
});

function SettingsNewRoutineRoute() {
	const { agent } = settingsNewRoutineRoute.useSearch();
	return (
		<SettingsLayout>
			<WorkspaceSettings section="routines" newRoutine={{ agentId: agent }} />
		</SettingsLayout>
	);
}

/** One model provider, by its id. */
const settingsProviderRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/providers/$provider",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsProviderRoute,
});

function SettingsProviderRoute() {
	const { provider } = settingsProviderRoute.useParams();
	return (
		<SettingsLayout>
			<WorkspaceSettings section="providers" selectedProviderId={provider} />
		</SettingsLayout>
	);
}

/** The one model the system bots share. A fixed path, which wins over a provider's id. */
const settingsSystemModelRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/providers/system",
	loader: () => WorkspaceSettings.preload(),
	component: () => (
		<SettingsLayout>
			<WorkspaceSettings section="providers" modelChoice="system" />
		</SettingsLayout>
	),
});

/** The model new bots start on. A fixed path, like the system bots' one. */
const settingsDefaultModelRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/providers/default",
	loader: () => WorkspaceSettings.preload(),
	component: () => (
		<SettingsLayout>
			<WorkspaceSettings section="providers" modelChoice="default" />
		</SettingsLayout>
	),
});

function SettingsPodRoute() {
	const { pod: podSlug } = settingsPodRoute.useParams();
	const { oauth_error: oauthError } = settingsPodRoute.useSearch();
	const navigate = settingsPodRoute.useNavigate();
	// Kept after the error leaves the address, so a reload does not show it twice.
	const [signInError, setSignInError] = useState(oauthError);
	useEffect(() => {
		if (oauthError === undefined) return;
		setSignInError(oauthError);
		void navigate({
			search: (previous) => ({ ...previous, oauth_error: undefined }),
			replace: true,
		});
	}, [oauthError, navigate]);
	const { data: pods, isPending, error } = usePods();
	const pod = findPod(pods, podSlug);
	if (isPending) return <SettingsLayout>{null}</SettingsLayout>;
	if (!pod) {
		return (
			<Panes>
				<EmptyState title={error ? "Could not load this pod" : "No such pod here"} />
			</Panes>
		);
	}
	return (
		<SettingsLayout>
			<WorkspaceSettings
				section="pods"
				selectedPodId={pod.id}
				connectionSignInError={signInError && signInFailureReason(signInError)}
			/>
		</SettingsLayout>
	);
}

function SettingsPodConnectionRoute() {
	const { pod: podSlug, connection } = settingsPodConnectionRoute.useParams();
	const { data: pods, isPending, error } = usePods();
	const pod = findPod(pods, podSlug);
	if (isPending) return <SettingsLayout>{null}</SettingsLayout>;
	if (!pod) {
		return (
			<Panes>
				<EmptyState title={error ? "Could not load this pod" : "No such pod here"} />
			</Panes>
		);
	}
	return (
		<SettingsLayout>
			<WorkspaceSettings section="pods" selectedPodId={pod.id} selectedConnectionId={connection} />
		</SettingsLayout>
	);
}

function SettingsPodAgentRoute() {
	const { pod: podSlug, agent: handle } = settingsPodAgentRoute.useParams();
	const { found, isPending, error } = usePodAgent(podSlug, handle);
	if (isPending) return <SettingsLayout>{null}</SettingsLayout>;
	if (!found) {
		return (
			<Panes>
				<EmptyState title={error ? "Could not load this agent" : "No such agent in this pod"} />
			</Panes>
		);
	}
	return (
		<SettingsLayout>
			<WorkspaceSettings section="agents" selectedAgentId={found.agent.id} />
		</SettingsLayout>
	);
}

function SettingsSectionRoute() {
	const { section } = settingsSectionRoute.useParams();
	const setting = workspaceSettingSection(section);
	// `general` is reachable by name too, which is how a phone's list opens it.
	if (!setting) {
		return <Navigate from="/$workspace" to="./settings" replace />;
	}
	return (
		<SettingsLayout>
			<WorkspaceSettings section={setting.id} />
		</SettingsLayout>
	);
}

/** Inbox: what is new across the workspace, and the chat, run or collaboration of each, opened in its place. */
const activityRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/activity",
	component: () => (
		<Panes>
			<Inbox>
				<Outlet />
			</Inbox>
		</Panes>
	),
});

/** With nothing chosen, how much is unread sits beside the list; on a phone the list is the page. */
const activityIndexRoute = createRoute({
	getParentRoute: () => activityRoute,
	path: "/",
	component: InboxOverview,
});

interface ActivityChatSearch extends ConversationSearch {
	/** A message to jump to in the chat, such as the mention the row is. */
	message?: string;
	/** A routine run or collaboration shown as the pane itself, in place of the chat. */
	threadPage?: string;
}

const activityChatRoute = createRoute({
	getParentRoute: () => activityRoute,
	path: "/$pod/$conversation",
	validateSearch: (search: Record<string, unknown>): ActivityChatSearch => ({
		...validateConversationSearch(search),
		...idParam(search, "message"),
		...idParam(search, "threadPage"),
	}),
	preloadStaleTime: 0,
	loader: ({ context, params }) => {
		prefetchConversation(context.queries, params.conversation);
		return ConversationPage.preload();
	},
	component: () => {
		const { pod, conversation } = activityChatRoute.useParams();
		const navigate = activityChatRoute.useNavigate();
		const search = activityChatRoute.useSearch();
		return (
			<PodConversationScreen podSlug={pod} conversationId={conversation}>
				{(found, user) => (
					<ActivityPane
						pod={found.pod}
						conversation={found.conversation}
						conversationId={conversation}
						user={user}
						threadPageId={search.threadPage}
						focusMessageId={search.message}
						threadId={search.thread}
						onThreadPageChange={(threadPage) =>
							void navigate({ search: (previous) => ({ ...previous, threadPage }) })
						}
						onThreadChange={(thread) =>
							void navigate({ search: (previous) => ({ ...previous, thread }) })
						}
						staged={stagedOf(search)}
						onStagedChange={(staged) =>
							void navigate({
								search: (previous) => ({ ...previous, ...stagedSearchOf(staged) }),
							})
						}
					/>
				)}
			</PodConversationScreen>
		);
	},
});

/** Every approval across the workspace, and each one in full on its own page. */
const approvalsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/approvals",
	component: () => (
		<Panes>
			<Outlet />
		</Panes>
	),
});

const approvalsIndexRoute = createRoute({
	getParentRoute: () => approvalsRoute,
	path: "/",
	component: Approvals,
});

const approvalRoute = createRoute({
	getParentRoute: () => approvalsRoute,
	path: "/$call",
	component: () => <ApprovalPage callId={approvalRoute.useParams().call} />,
});

/** Where `/` and closing settings land: the first shared pod, or Personal for somebody in none. */
const agentsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/agents",
	loader: preloadChatScreenForWideLayout,
	component: AgentsRoute,
});

function AgentsRoute() {
	const { data: pods, isPending, error } = usePods();
	if (isPending) return <Panes>{null}</Panes>;
	if (error)
		return (
			<Panes>
				<EmptyState title="Could not load your pods" />
			</Panes>
		);
	const first = defaultPod(pods);
	if (!first) {
		return (
			<Panes>
				<EmptyState title="No pods here yet" />
			</Panes>
		);
	}
	return <Navigate {...podLink(first)} replace />;
}

const podRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/pods/$pod",
	loader: preloadChatScreenForWideLayout,
	component: PodRoute,
});

/** A pod's page beside the sidebar. On a phone, the pod's own address shows the sidebar alone. */
function PodRoute() {
	const { pod: podSlug } = podRoute.useParams();
	const matchRoute = useMatchRoute();
	const atPod = Boolean(matchRoute({ to: podRoute.fullPath }));
	const { data: pods, isPending, error } = usePods();
	const pod = findPod(pods, podSlug);
	if (isPending) return <Panes>{null}</Panes>;
	if (!pod) {
		return (
			<Panes>
				<EmptyState title={error ? "Could not load this pod" : "No such pod here"}>
					{error
						? "The API did not answer. Reload, or check that it is running."
						: "It may have been removed, or you may not be a member of it."}
				</EmptyState>
			</Panes>
		);
	}
	return (
		<Panes className={atPod ? "max-md:hidden" : undefined}>
			<Outlet />
		</Panes>
	);
}

const podIndexRoute = createRoute({
	getParentRoute: () => podRoute,
	path: "/",
	component: PodIndexRoute,
});

function PodIndexRoute() {
	const { pod: podSlug } = podRoute.useParams();
	const pod = findPod(usePods().data, podSlug);
	return pod ? <OpenTopChat pod={pod} /> : null;
}

/**
 * A pod opened without a chat chosen opens its chat, or, in a Personal pod,
 * which has none, the list's top one, where the list and the chat sit side by
 * side. On a phone the list is the page, so it stays.
 */
function OpenTopChat({ pod }: { pod: Pod }) {
	const sideBySide = useMediaQuery(SIDE_BY_SIDE);
	const { data: list } = useChatList(pod.slug);
	if (!sideBySide) return null;
	if (pod.kind === "shared" && list) {
		const first = list.chats.find((chat) => chat.conversation.main);
		return (
			<Navigate
				{...(first
					? conversationLink({ pod, conversationId: first.conversation.id })
					: podChatLink(pod))}
				replace
			/>
		);
	}
	const top = list?.threads[0];
	if (!top) return null;
	return <Navigate {...conversationLink({ pod, conversationId: top.conversation.id })} replace />;
}

/**
 * Where a pod opens its top chat beside the sidebar. On a phone, touching a chat's
 * link preloads it instead, through `agentRoute`'s loader.
 */
function preloadChatScreenForWideLayout() {
	if (matchesMedia(SIDE_BY_SIDE)) ConversationPage.preload();
}

const artifactsRoute = createRoute({
	getParentRoute: () => podRoute,
	path: "/artifacts",
	component: () => {
		const pod = findPod(usePods().data, artifactsRoute.useParams().pod);
		return pod ? <ArtifactsPage pod={pod} /> : null;
	},
});

interface ArtifactSearch {
	/** An earlier version to show; the current one when absent. */
	version?: number;
}

const validateArtifactSearch = (search: Record<string, unknown>): ArtifactSearch =>
	typeof search.version === "number" && Number.isInteger(search.version) && search.version > 0
		? { version: search.version }
		: {};

const artifactRoute = createRoute({
	getParentRoute: () => podRoute,
	path: "/artifacts/$artifact",
	validateSearch: validateArtifactSearch,
	component: () => {
		const { pod: podSlug, artifact } = artifactRoute.useParams();
		const { version } = artifactRoute.useSearch();
		const pod = findPod(usePods().data, podSlug);
		return pod ? <ArtifactsPage pod={pod} selectedId={artifact} version={version} /> : null;
	},
});

interface ConversationSearch {
	/** A collaboration or routine thread open beside the chat. */
	thread?: string;
	/** An artifact open large beside the chat, in place of the conversation list. */
	artifact?: string;
	/** An earlier version of `artifact` to show; the current one when absent. */
	version?: number;
	/** The bot's sandbox desktop open large beside the chat, when no artifact is. */
	desktop?: true;
}

const validateConversationSearch = (search: Record<string, unknown>): ConversationSearch => {
	const { artifact } = idParam(search, "artifact");
	return {
		...idParam(search, "thread"),
		...(artifact
			? { artifact, ...validateArtifactSearch(search) }
			: search.desktop === true
				? { desktop: true }
				: {}),
	};
};

/** What `search` opens beside a chat, and the search that opens `staged`. */
const stagedOf = (search: ConversationSearch): Staged | undefined =>
	search.artifact
		? { kind: "artifact", artifactId: search.artifact, version: search.version }
		: search.desktop
			? { kind: "desktop" }
			: undefined;

const stagedSearchOf = (staged: Staged | undefined): ConversationSearch => ({
	artifact: staged?.kind === "artifact" ? staged.artifactId : undefined,
	version: staged?.kind === "artifact" ? staged.version : undefined,
	desktop: staged?.kind === "desktop" ? true : undefined,
});

/**
 * `search[name]` when it is an id, and otherwise undefined. Said either way,
 * because the router keeps the address's raw value under any name a route's
 * validation leaves out.
 */
function idParam<Name extends string>(
	search: Record<string, unknown>,
	name: Name,
): { [key in Name]: string | undefined } {
	const value = search[name];
	return { [name]: typeof value === "string" && isUuid(value) ? value : undefined } as {
		[key in Name]: string | undefined;
	};
}

/** The pod's routines, with the one chosen beside them: its own thread, where its runs post. */
const routinesRoute = createRoute({
	getParentRoute: () => podRoute,
	path: "/routines",
	// The bot whose routines the page is, when none of them is open yet.
	validateSearch: (search: Record<string, unknown>): { bot?: string } =>
		typeof search.bot === "string" ? { bot: search.bot } : {},
	component: () => {
		const { pod: podSlug } = routinesRoute.useParams();
		const { routine } = useParams({ strict: false });
		const { bot } = routinesRoute.useSearch();
		const pod = findPod(usePods().data, podSlug);
		return pod ? (
			<RoutinesPage pod={pod} selectedRoutineId={routine} botHandle={bot}>
				<Outlet />
			</RoutinesPage>
		) : null;
	},
});

/** With none chosen, the bot's first routine, or the pod's, opens beside the list; on a phone the list is the page. */
const routinesIndexRoute = createRoute({
	getParentRoute: () => routinesRoute,
	path: "/",
	component: () => {
		const pod = findPod(usePods().data, routinesIndexRoute.useParams().pod);
		const { bot } = routinesIndexRoute.useSearch();
		const sideBySide = useMediaQuery(SIDE_BY_SIDE);
		const { data: list } = useChatList(pod?.slug);
		const first = list?.routines.find((row) => bot === undefined || row.agent.handle === bot);
		if (!pod || !sideBySide || !first) return null;
		return <Navigate {...routineThreadLink(pod, first.routine.id)} replace />;
	},
});

/** A routine's own thread, opened first if it has none, beside the pod's routines. */
const routineThreadRoute = createRoute({
	getParentRoute: () => routinesRoute,
	path: "/$routine",
	validateSearch: validateConversationSearch,
	loader: () => ConversationPage.preload(),
	component: () => {
		const { pod: podSlug, routine } = routineThreadRoute.useParams();
		const pod = findPod(usePods().data, podSlug);
		return pod ? <RoutineFeed key={routine} pod={pod} routineId={routine} /> : null;
	},
});

/** The routine's own thread, opened first when it has none, as a chat beside the routines. */
function RoutineFeed({ pod, routineId }: { pod: Pod; routineId: string }) {
	const opened = useOpenRoutineFeed(pod, routineId);
	const navigate = routineThreadRoute.useNavigate();
	const search = routineThreadRoute.useSearch();
	if (opened.isError) {
		return (
			<EmptyState title="Could not open this routine">
				It may have been removed. Reload this page to try again.
			</EmptyState>
		);
	}
	if (!opened.data) return null;
	const conversationId = opened.data.id;
	return (
		<PodConversationScreen podSlug={pod.slug} conversationId={conversationId}>
			{(found, user) => (
				<ConversationPage
					conversation={found.conversation}
					pod={found.pod}
					conversationId={conversationId}
					user={user}
					threadId={search.thread}
					onThreadChange={(thread) =>
						void navigate({ search: (previous) => ({ ...previous, thread }) })
					}
					staged={stagedOf(search)}
					onStagedChange={(staged) =>
						void navigate({ search: (previous) => ({ ...previous, ...stagedSearchOf(staged) }) })
					}
				/>
			)}
		</PodConversationScreen>
	);
}

/** The pod's chat, opened first if nobody has, then shown at its own address. */
const podChatRoute = createRoute({
	getParentRoute: () => podRoute,
	path: "/chat",
	loader: () => ConversationPage.preload(),
	component: () => {
		const { pod: podSlug } = podChatRoute.useParams();
		const pod = findPod(usePods().data, podSlug);
		return pod ? <OpenPodChat pod={pod} /> : null;
	},
});

function OpenPodChat({ pod }: { pod: Pod }) {
	return (
		<NavigateWhenOpened
			pod={pod}
			opened={useOpenPodChat(pod)}
			failure={{ title: "Could not open this pod's channel", body: API_DID_NOT_ANSWER }}
		/>
	);
}

/** A bot's channel, opened first if nobody has, then shown at its own address. */
const agentRoute = createRoute({
	getParentRoute: () => podRoute,
	path: "/agents/$agent",
	validateSearch: validateConversationSearch,
	loader: () => ConversationPage.preload(),
	component: () => {
		const { pod, agent } = agentRoute.useParams();
		const search = agentRoute.useSearch();
		return (
			<PodAgentScreen podSlug={pod} handle={agent}>
				{(found) => <OpenBotChannel pod={found.pod} agent={found.agent} search={search} />}
			</PodAgentScreen>
		);
	},
});

/** Opens `agent`'s channel in `pod`, keeping what `search` opens beside it. */
function OpenBotChannel({
	pod,
	agent,
	search,
}: {
	pod: Pod;
	agent: Agent;
	search: ConversationSearch;
}) {
	return (
		<NavigateWhenOpened
			pod={pod}
			opened={useOpenBotChannel(pod, agent.id)}
			failure={{ title: "Could not open this channel", body: API_DID_NOT_ANSWER }}
			search={search}
		/>
	);
}

const API_DID_NOT_ANSWER = "The API did not answer. Reload this page to try again.";

/**
 * Goes to the conversation `opened` finds or opens, at its own address and in
 * place of this one, keeping `search`; says `failure` when it cannot.
 */
function NavigateWhenOpened({
	pod,
	opened,
	failure,
	search,
}: {
	pod: Pod;
	opened: { data: { id: string } | undefined; isError: boolean };
	failure: { title: string; body: string };
	search?: ConversationSearch;
}) {
	if (opened.isError) return <EmptyState title={failure.title}>{failure.body}</EmptyState>;
	if (!opened.data) return null;
	return (
		<Navigate
			{...conversationLink({ pod, conversationId: opened.data.id })}
			search={search}
			replace
		/>
	);
}

/** Starting a thread in a pod, from its first message, with the bot `?agent=` names by its handle. */
const newThreadRoute = createRoute({
	getParentRoute: () => podRoute,
	path: "/threads/new",
	validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
		agent: optionalString(search.agent),
	}),
	component: () => {
		const { pod: podSlug } = newThreadRoute.useParams();
		const { agent } = newThreadRoute.useSearch();
		const pod = findPod(usePods().data, podSlug);
		const { user } = useSession();
		// Keyed so a + on another bot starts its draft afresh.
		return pod && user ? (
			<NewThread key={agent} pod={pod} userId={user.id} agentHandle={agent} />
		) : null;
	},
});

const conversationRoute = createRoute({
	getParentRoute: () => podRoute,
	path: "/threads/$conversation",
	validateSearch: validateConversationSearch,
	// On every hover, not once per 30 s: the query cache, not the router,
	// decides what of the conversation is still fresh.
	preloadStaleTime: 0,
	// Also run while the pointer is on a link here, so it is loading before the click.
	loader: ({ context, params }) => {
		prefetchConversation(context.queries, params.conversation);
		return ConversationPage.preload();
	},
	component: () => {
		const { pod, conversation } = conversationRoute.useParams();
		const navigate = conversationRoute.useNavigate();
		const search = conversationRoute.useSearch();
		return (
			<PodConversationScreen podSlug={pod} conversationId={conversation}>
				{(found, user) => (
					<ConversationPage
						conversation={found.conversation}
						pod={found.pod}
						conversationId={conversation}
						user={user}
						threadId={search.thread}
						onThreadChange={(thread) =>
							void navigate({ search: (previous) => ({ ...previous, thread }) })
						}
						staged={stagedOf(search)}
						onStagedChange={(staged) =>
							void navigate({
								search: (previous) => ({ ...previous, ...stagedSearchOf(staged) }),
							})
						}
					/>
				)}
			</PodConversationScreen>
		);
	},
});

/**
 * The pod at `podSlug` and the bot the conversation is with, once found, for a
 * screen of the conversation; while it loads nothing, and if it cannot be
 * found, why.
 */
function PodConversationScreen({
	podSlug,
	conversationId,
	children,
}: {
	podSlug: string;
	conversationId: string;
	children: (found: ConversationPlace, user: SessionUser) => ReactNode;
}) {
	const { user } = useSession();
	const { found, isPending, error } = useConversationPlace(podSlug, conversationId);

	if (isPending) return null;
	if (!found) {
		return (
			<EmptyState title={error ? "Could not load this conversation" : "No such conversation here"}>
				{error
					? "The API did not answer. Reload, or check that it is running."
					: "It may have been removed — or you may not be a member of the pod it is in."}
			</EmptyState>
		);
	}
	if (!user) return null;
	return (
		// The screen's code can arrive after its data. Without a boundary of its
		// own, React would hide the sidebar with it while it loads.
		<Suspense fallback={null}>{children(found, user)}</Suspense>
	);
}

/**
 * The bot at `handle` in the pod at `podSlug`, once found, for a screen of its
 * chat; while it loads nothing, and if it cannot be found, why.
 */
function PodAgentScreen({
	podSlug,
	handle,
	children,
}: {
	podSlug: string;
	handle: string;
	children: (found: { pod: Pod; agent: Agent }, user: SessionUser) => ReactNode;
}) {
	const { user } = useSession();
	const { found, isPending, error } = usePodAgent(podSlug, handle);

	if (isPending) return null;
	if (!found) {
		return (
			<EmptyState title={error ? "Could not load this agent" : "No such agent here"}>
				{error
					? "The API did not answer. Reload, or check that it is running."
					: "It may have been removed, or renamed — or you may not be a member of any pod it is in."}
			</EmptyState>
		);
	}
	if (!user) return null;
	return (
		// The screen's code can arrive after its data. Without a boundary of its
		// own, React would hide the sidebar with it while it loads.
		<Suspense fallback={null}>{children(found, user)}</Suspense>
	);
}

/**
 * Signed out means the login page. `undefined` cannot reach here: `main.tsx`
 * waits for `/me` to answer before it mounts the router at all.
 */
function requireUser({
	context,
	location,
}: {
	context: RouterContext;
	location: ParsedLocation;
}): void {
	if (context.user === null) {
		throw redirect({
			to: "/login",
			search: location.href === "/" ? {} : { returnTo: location.href },
		});
	}
}

const routeTree = rootRoute.addChildren([
	indexRoute,
	loginRoute,
	joinRoute,
	resetPasswordRoute,
	inviteRoute,
	signInReturnRoute,
	gitHubSetupReturnRoute,
	onboardingRoute,
	shellRoute.addChildren([
		workspaceIndexRoute,
		settingsRoute,
		settingsSectionRoute,
		settingsMemberRoute,
		settingsNewRoutineRoute,
		settingsRoutineRoute,
		settingsPodAgentRoute,
		settingsPodConnectionRoute,
		settingsPodRoute,
		settingsSystemModelRoute,
		settingsDefaultModelRoute,
		settingsProviderRoute,
		agentsRoute,
		activityRoute.addChildren([activityIndexRoute, activityChatRoute]),
		approvalsRoute.addChildren([approvalsIndexRoute, approvalRoute]),
		podRoute.addChildren([
			podIndexRoute,
			agentRoute,
			podChatRoute,
			routinesRoute.addChildren([routinesIndexRoute, routineThreadRoute]),
			newThreadRoute,
			conversationRoute,
			artifactsRoute,
			artifactRoute,
		]),
	]),
]);

export function createAppRouter(options?: { history?: RouterHistory }) {
	return createRouter({
		routeTree,
		// Supplied by `RouterProvider` once the session is known.
		context: undefined as unknown as RouterContext,
		defaultPreload: "intent",
		// A boundary for every route, so a failed page is replaced inside its parent and the sidebar
		// stays. The router's own boundary is above the root.
		defaultErrorComponent: PageFailure,
		// Tests mount the real tree over a memory history, so a route's guards
		// and search params are exercised rather than mocked around.
		...options,
	});
}

/** The app's routes, signed in as `session`: guards read who you are from it, and so do components. */
export function AppRouterProvider({
	router,
	session,
}: {
	router: ReturnType<typeof createAppRouter>;
	session: Session;
}) {
	const queries = useQueryClient();
	return (
		<SessionContext value={session}>
			<RouterProvider router={router} context={{ user: session.user, queries }} />
		</SessionContext>
	);
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>;
	}
}

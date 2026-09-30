import type { Pod, Workspace } from "@sugabots/contracts";
import { CONNECTION_SIGN_IN_RETURN_PATH } from "@sugabots/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ParsedLocation, RouterHistory } from "@tanstack/react-router";
import {
	createRootRouteWithContext,
	createRoute,
	createRouter,
	Link,
	Navigate,
	Outlet,
	redirect,
	useNavigate,
	useParams,
	useRouteContext,
	useRouter,
} from "@tanstack/react-router";
import { type ComponentType, lazy, Suspense, useEffect, useRef, useState } from "react";
import { usePodAgent } from "@/lib/agents.ts";
import { useChatList } from "@/lib/chats.ts";
import { signInFailureReason } from "@/lib/connections.ts";
import { agentChatLink, podLink } from "@/lib/links.ts";
import { matchesMedia, SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { useOnboarding } from "@/lib/onboarding.ts";
import { RESET_PASSWORD_PATH } from "@/lib/password-reset.ts";
import { findPod, podsQuery, usePods } from "@/lib/pods.ts";
import type { Session } from "@/lib/session.ts";
import {
	chooseWorkspace,
	useDeleteWorkspace,
	useWorkspace,
	useWorkspaces,
} from "@/lib/workspace.ts";
import { workspaceSettingSection } from "@/lib/workspace-settings.ts";
import { SettingsLayout } from "@/screens/SettingsLayout.tsx";
import { ConversationList } from "@/shell/ConversationList.tsx";
import { Panes, Shell } from "@/shell/Shell.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";

const AgentPage = lazyNamed(() => import("@/screens/AgentPage.tsx"), "AgentPage");
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
 *   /invite/$id
 *   /connections/oauth/return        where a connection's sign-in comes back
 *   /$workspace/settings     workspace settings
 *   /$workspace/agents       lands on the first shared pod, or on Personal when there is none
 *   /$workspace/pods/$pod    one pod's conversation list
 *   /$workspace/pods/$pod/agents/$agent       one agent's chat, by pod slug and agent handle
 *   /$workspace/settings/members/$member   one person, by membership id
 *   /$workspace/settings/pods/$pod   workspace pod detail
 *   /$workspace/settings/pods/$pod/agents/$agent   agent configuration
 *   /$workspace/settings/providers/$provider   one model provider
 *   /$workspace/settings/providers/default  the model new bots start on
 *   /$workspace/settings/providers/system   the model the system bots use
 *
 * An agent's address names its pod, because a handle is unique only within
 * one, and uses the handle rather than the name, so renaming an agent keeps
 * its links. A collaboration or routine run has no address of its own: it
 * opens beside its bot's chat, as `?thread=`.
 */

export interface RouterContext {
	session: Session;
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

function LandingRoute() {
	const { workspace, isPending, error, refetch } = useWorkspace();
	if (isPending) return <div className="h-full bg-list" />;
	if (error) return <RouteLoadFailure title="Could not load your workspace" onRetry={refetch} />;
	if (!workspace) return <Navigate to="/onboarding" replace />;
	return <Navigate to="/$workspace/agents" params={{ workspace: workspace.slug }} replace />;
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
	const { session } = loginRoute.useRouteContext();
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
	const { session } = resetPasswordRoute.useRouteContext();
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

	if (onboarding.isPending || workspace.isPending) return <div className="h-full bg-list" />;
	if (onboarding.error || workspace.error) {
		return (
			<RouteLoadFailure
				title="Could not start setup"
				onRetry={() => Promise.all([onboarding.refetch(), workspace.refetch()])}
			/>
		);
	}
	if (onboarding.data?.completed) {
		// The first run is done once, so somebody who has deleted every workspace since sets up another.
		return workspace.workspace ? (
			<Navigate to="/$workspace/agents" params={{ workspace: workspace.workspace.slug }} replace />
		) : (
			<Navigate to="/onboarding/new" replace />
		);
	}
	return <Onboarding session={session} />;
}

/**
 * Setting up another workspace, with the same steps as the first. Under
 * `/onboarding` because any new top-level path would hide a workspace whose
 * address it is.
 */
interface NewWorkspaceSearch {
	/** The workspace this has made, by its address, so a reload picks up where it got to. */
	workspace?: string;
}

const newWorkspaceRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/onboarding/new",
	validateSearch: (search: Record<string, unknown>): NewWorkspaceSearch => ({
		workspace: typeof search.workspace === "string" ? search.workspace : undefined,
	}),
	beforeLoad: requireUser,
	component: NewWorkspaceRoute,
});

function NewWorkspaceRoute() {
	const session = newWorkspaceRoute.useRouteContext().session;
	const { workspace: madeSlug } = newWorkspaceRoute.useSearch();
	const { workspace, isPending, error, refetch } = useWorkspace();
	const workspaces = useWorkspaces();

	if (isPending) return <div className="h-full bg-list" />;
	if (error) return <RouteLoadFailure title="Could not start setup" onRetry={refetch} />;
	return (
		<NewWorkspaceOnboarding
			session={session}
			cameFrom={workspace}
			made={workspaces.data?.find((one) => one.slug === madeSlug)}
			hasAnother={workspaces.data?.some((one) => one.slug !== madeSlug) ?? false}
		/>
	);
}

/**
 * Making the workspace chooses it, and the steps after work in the one chosen,
 * so a reload chooses it again. Cancel chooses again the one this was opened
 * from and goes back to the page it was opened on.
 *
 * Cancel deletes only a workspace this page made. One the address names from
 * before, as after a reload or on coming back to setup by Back, may have been
 * finished and shared since, and stays.
 */
function NewWorkspaceOnboarding({
	session,
	cameFrom,
	made,
	hasAnother,
}: {
	session: Session;
	cameFrom: Workspace | undefined;
	made: Workspace | undefined;
	/** Whether there is a workspace besides the one being made to go back to. */
	hasAnother: boolean;
}) {
	const router = useRouter();
	const [returnTo] = useState(cameFrom);
	const chosen = useWorkspace().workspace;
	const deleteWorkspace = useDeleteWorkspace();
	const [leaving, setLeaving] = useState(false);
	const madeHere = useRef<string>(undefined);
	const choosingMade = !leaving && made !== undefined && chosen?.id !== made.id;

	useEffect(() => {
		if (choosingMade) chooseWorkspace(made.id);
	}, [choosingMade, made]);

	async function cancel() {
		setLeaving(true);
		// One that cannot be deleted now stays, for its settings to delete; leaving still goes ahead.
		if (made && made.id === madeHere.current) {
			await deleteWorkspace.mutateAsync(made.id).catch(() => undefined);
		}
		// After a reload the one this came from is not known, and deleting this one leaves another chosen.
		if (returnTo && returnTo.id !== made?.id) chooseWorkspace(returnTo.id);
		if (router.history.canGoBack()) router.history.back();
		else void router.navigate({ to: "/" });
	}

	if (choosingMade) return <div className="h-full bg-list" />;
	return (
		<Onboarding
			session={session}
			newWorkspace={{
				made,
				onMade: (saved) => {
					// Before the address names one, saving it was making it.
					if (!made) madeHere.current = saved.id;
					void router.navigate({
						to: "/onboarding/new",
						search: { workspace: saved.slug },
						replace: true,
					});
				},
				onCancel: hasAnother ? () => void cancel() : undefined,
			}}
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
	const onboarding = useOnboarding();
	const workspace = useWorkspace();
	const workspaces = useWorkspaces();

	if (onboarding.isPending || workspace.isPending) return <div className="h-full bg-list" />;
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
	return <Shell />;
}

function RouteLoadFailure({ title, onRetry }: { title: string; onRetry: () => Promise<unknown> }) {
	return (
		<div className="grid h-full place-items-center bg-list p-6">
			<EmptyState title={title}>
				<button type="button" className="text-link underline" onClick={() => void onRetry()}>
					Try again
				</button>
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
	validateSearch: (search: Record<string, unknown>): { tab?: "routines" } =>
		search.tab === "routines" ? { tab: "routines" } : {},
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

function SettingsPodAgentRoute() {
	const { pod: podSlug, agent: handle } = settingsPodAgentRoute.useParams();
	const { tab } = settingsPodAgentRoute.useSearch();
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
			<WorkspaceSettings section="agents" selectedAgentId={found.agent.id} selectedAgentTab={tab} />
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
	const first =
		pods?.find((pod) => pod.kind === "shared") ?? pods?.find((pod) => pod.kind === "personal");
	if (!first) {
		return (
			<Panes>
				<EmptyState title="No pods here yet" />
			</Panes>
		);
	}
	return <Navigate {...podLink(first)} replace />;
}

/** A conversation list beside the thread it opens. */
function ConversationLayout({
	pod,
	selectedAgentId,
	children,
}: {
	pod: Pod;
	selectedAgentId: string | undefined;
	children: React.ReactNode;
}) {
	// On a phone the list and the thread take turns: a chosen chat covers the list.
	const chatOpen = selectedAgentId !== undefined;
	return (
		<>
			<ConversationList
				pod={pod}
				selectedAgentId={selectedAgentId}
				className={chatOpen ? "max-md:hidden" : undefined}
			/>
			<Panes className={chatOpen ? undefined : "max-md:hidden"}>{children}</Panes>
		</>
	);
}

const podRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/pods/$pod",
	loader: preloadChatScreenForWideLayout,
	component: PodRoute,
});

function PodRoute() {
	const { pod: podSlug } = podRoute.useParams();
	const { agent: handle } = useParams({ strict: false });
	const { data: pods, isPending, error } = usePods();
	const { found } = usePodAgent(podSlug, handle ?? "");
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
		<ConversationLayout pod={pod} selectedAgentId={found?.agent.id}>
			<Outlet />
		</ConversationLayout>
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
 * A pod opened without a chat chosen opens the list's top one, where
 * the list and the chat sit side by side. On a phone the list is the page, so
 * it stays.
 */
function OpenTopChat({ pod }: { pod: Pod }) {
	const sideBySide = useMediaQuery(SIDE_BY_SIDE);
	const { data: list } = useChatList(pod.id);
	if (!sideBySide) return null;
	const top = list?.items[0];
	if (!top) return null;
	return <Navigate {...agentChatLink({ pod, agent: top.agent })} replace />;
}

/**
 * Where a pod opens its top chat beside the list. On a phone, touching a chat's
 * link preloads it instead, through `agentRoute`'s loader.
 */
function preloadChatScreenForWideLayout() {
	if (matchesMedia(SIDE_BY_SIDE)) AgentPage.preload();
}

interface AgentSearch {
	/** A collaboration or routine thread open beside the chat. */
	thread?: string;
}

const validateAgentSearch = (search: Record<string, unknown>): AgentSearch =>
	typeof search.thread === "string" ? { thread: search.thread } : {};

const agentRoute = createRoute({
	getParentRoute: () => podRoute,
	path: "/agents/$agent",
	validateSearch: validateAgentSearch,
	loader: () => AgentPage.preload(),
	component: () => {
		const { pod, agent } = agentRoute.useParams();
		const navigate = agentRoute.useNavigate();
		return (
			<AgentChatRoute
				podSlug={pod}
				handle={agent}
				search={agentRoute.useSearch()}
				onSearchChange={(change) =>
					void navigate({ search: (previous) => ({ ...previous, ...change }) })
				}
			/>
		);
	},
});

function AgentChatRoute({
	podSlug,
	handle,
	search,
	onSearchChange,
}: {
	podSlug: string;
	handle: string;
	search: AgentSearch;
	onSearchChange: (change: AgentSearch) => void;
}) {
	const { user } = useRouteContext({ from: "__root__" }).session;
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
		// own, React would hide the rail and list with it while it loads.
		<Suspense fallback={null}>
			<AgentPage
				agent={found.agent}
				pod={found.pod}
				user={user}
				threadId={search.thread}
				onThreadChange={(thread) => onSearchChange({ thread })}
			/>
		</Suspense>
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
	if (context.session.user === null) {
		throw redirect({
			to: "/login",
			search: location.href === "/" ? {} : { returnTo: location.href },
		});
	}
}

const routeTree = rootRoute.addChildren([
	indexRoute,
	loginRoute,
	resetPasswordRoute,
	inviteRoute,
	signInReturnRoute,
	onboardingRoute,
	newWorkspaceRoute,
	shellRoute.addChildren([
		workspaceIndexRoute,
		settingsRoute,
		settingsSectionRoute,
		settingsMemberRoute,
		settingsPodAgentRoute,
		settingsPodRoute,
		settingsSystemModelRoute,
		settingsDefaultModelRoute,
		settingsProviderRoute,
		agentsRoute,
		podRoute.addChildren([podIndexRoute, agentRoute]),
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

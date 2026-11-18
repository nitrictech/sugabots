import type {
	Bot,
	Channel,
	SessionUser,
	Workspace,
	WorkspacePermissions,
} from "@sugabots/contracts";
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
	useLocation,
	useMatch,
	useMatchRoute,
	useNavigate,
	useParams,
	useRouter,
	useSearch,
} from "@tanstack/react-router";
import { cn } from "cn";
import { MessageSquareOff } from "lucide-react";
import { type ComponentType, lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { validate as isUuid } from "uuid";
import {
	botsQuery,
	useAssistant,
	useBots,
	useBotWithHandle,
	useEnsureAssistant,
} from "@/lib/bots.ts";
import { findChannel, useChannels, useJoinChannel } from "@/lib/channels.ts";
import {
	type ConversationPlace,
	placeBot,
	prefetchConversation,
	useAnyConversationPlace,
	useBotConversationPlace,
	useBotTasks,
	useChannelConversationPlace,
	useDirectMessage,
	useOpenAutomationFeed,
	useOpenChannelConversation,
} from "@/lib/chats.ts";
import { signInFailureReason } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { followTrail, historyIndex } from "@/lib/history-trail.ts";
import {
	automationFeedLink,
	automationsLink,
	botLink,
	botSettingsLink,
	conversationLink,
	newTaskLink,
	type TasksTab,
} from "@/lib/links.ts";
import { matchesMedia, SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { RESET_PASSWORD_PATH } from "@/lib/password-reset.ts";
import { loadFailure } from "@/lib/query.ts";
import { type Session, SessionContext, useSession } from "@/lib/session.ts";
import {
	chooseWorkspace,
	useDeleteWorkspace,
	useWorkspace,
	useWorkspaceStanding,
	useWorkspaces,
} from "@/lib/workspace.ts";
import {
	botSettingsPage,
	channelSettingsPage,
	workspaceSettingSection,
} from "@/lib/workspace-settings.ts";
import { ApprovalPage } from "@/screens/ApprovalPage.tsx";
import type { AutomationsView } from "@/screens/AutomationsStage.tsx";
import type { Staged } from "@/screens/ConversationChat.tsx";
import { FilesPage } from "@/screens/Files.tsx";
import { SettingsLayout } from "@/screens/SettingsLayout.tsx";
import { Approvals } from "@/shell/Approvals.tsx";
import { AutomationsPage, useListedAutomations } from "@/shell/Automations.tsx";
import { BotsDirectory } from "@/shell/BotsDirectory.tsx";
import { ChannelsDirectory } from "@/shell/ChannelsDirectory.tsx";
import { DirectMessagesOverview } from "@/shell/DirectMessages.tsx";
import { Inbox, InboxOverview } from "@/shell/Inbox.tsx";
import { LoadFailure } from "@/shell/LoadFailure.tsx";
import { MobileDirectMessages, MobileHome } from "@/shell/MobileHome.tsx";
import { PageFailure } from "@/shell/PageFailure.tsx";
import { Panes, Shell } from "@/shell/Shell.tsx";
import { You } from "@/shell/You.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";

const ConversationPage = lazyNamed(
	() => import("@/screens/ConversationPage.tsx"),
	"ConversationPage",
);
const NewTask = lazyNamed(() => import("@/screens/NewTask.tsx"), "NewTask");
// Lazy as the conversation is: it shows the one there already is with the people chosen.
const NewDirectMessagePage = lazyNamed(
	() => import("@/shell/NewDirectMessage.tsx"),
	"NewDirectMessagePage",
);
const InboxPane = lazyNamed(
	() => import("@/screens/InboxPane.tsx").then(({ InboxPane }) => ({ InboxPane })),
	"InboxPane",
);
// Its own export, or the module's other exports would decide the props.
const ItemConversationPage = lazyNamed(
	() =>
		import("@/screens/InboxPane.tsx").then(({ ItemConversationPage }) => ({
			ItemConversationPage,
		})),
	"ItemConversationPage",
);
const Invite = lazyNamed(() => import("@/screens/Invite.tsx"), "Invite");
const Login = lazyNamed(() => import("@/screens/Login.tsx"), "Login");
const ResetPassword = lazyNamed(
	// Only this export: the module's other screen would otherwise decide the props.
	() => import("@/screens/ResetPassword.tsx").then(({ ResetPassword }) => ({ ResetPassword })),
	"ResetPassword",
);
const Onboarding = lazyNamed(() => import("@/screens/Onboarding.tsx"), "Onboarding");
// Its own export, or the module's other exports would decide the props.
const AutomationSetup = lazyNamed(
	() =>
		import("@/screens/AutomationEditing.tsx").then(({ AutomationSetup }) => ({ AutomationSetup })),
	"AutomationSetup",
);
// Its own export, or the module's other exports would decide the props.
const NewAutomation = lazyNamed(
	() => import("@/screens/AutomationEditing.tsx").then(({ NewAutomation }) => ({ NewAutomation })),
	"NewAutomation",
);
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
 *   /$workspace              the person's Personal Assistant
 *   /$workspace/settings     workspace settings
 *   /$workspace/inbox     what is new across the workspace: mentions, unread messages, automation runs and collaborations
 *   /$workspace/inbox/$conversation   the conversation, run or collaboration of the one chosen, beside them
 *   /$workspace/dm           your direct messages with other people
 *   /$workspace/dm/new       starting one, with one person or a group
 *   /$workspace/dm/$conversation   one of them, by its id, `?message=` jumped to
 *   /$workspace/approvals    every approval across the workspace
 *   /$workspace/approvals/$call   one of them in full, by its tool call's id
 *   /$workspace/channels     every channel the person is in or could join
 *   /$workspace/channels/$channel   a channel, which opens its main chat
 *   /$workspace/channels/$channel/$conversation   its main chat or one of its threads
 *   /$workspace/channels/$channel/files[/$file]   the files made in it
 *   /$workspace/bots         every bot the person reaches
 *   /$workspace/bots/$bot    a bot, which opens its newest task, or a new one
 *   /$workspace/bots/$bot/new   starting a task from its first message
 *   /$workspace/bots/$bot/tasks/$conversation   one of its tasks, or an automation's feed
 *   /$workspace/bots/$bot/files[/$file]   the files it made
 *   /$workspace/bots/$bot/automations[/new|/$automation]   its automations
 *   /$workspace/tasks/$conversation   a task by its id alone, which goes on to its bot's address
 *   /$workspace/settings/members/$member   one person, by membership id
 *   /$workspace/settings/channels/$channel[/$page]   a channel's settings
 *   /$workspace/settings/bots/$bot[/$page]   a bot's settings: General, Connections or Computer
 *   /$workspace/settings/bots/$bot/connections/$connection   one connection, by id
 *   /$workspace/settings/providers/$provider   one model provider
 *   /$workspace/settings/providers/default  the model new bots start on
 *   /$workspace/settings/providers/system   the model the system bots use
 *
 * A bot's address uses its handle, unique in its workspace, rather than its
 * name, so renaming a bot keeps its links. A collaboration or automation run
 * has no address of its own: it opens beside its conversation, as `?item=`.
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
	const { workspace: chosen, isPending, failure, refetch } = useWorkspace();
	const workspaces = useWorkspaces();
	const standing = useWorkspaceStanding();
	if (failure) {
		return (
			<LoadFailure title="Could not load your workspace" error={failure.error} retry={refetch} />
		);
	}
	if (isPending) return <div className="h-full bg-list" />;
	if (!chosen) return <Navigate to="/onboarding" replace />;
	if (chosen.setupCompletedAt === null && standing.isPending) {
		return <div className="h-full bg-list" />;
	}
	const setUp = workspaces.data?.find((one) => one.setupCompletedAt !== null);
	const landing = setUp && opensIntoSetup(chosen, standing.data?.permissions) ? setUp : chosen;
	return <Navigate to="/$workspace" params={{ workspace: landing.slug }} replace />;
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
	bot?: string;
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
		bot: optionalString(search.bot),
		oauth_error: optionalString(search.oauth_error),
	}),
	beforeLoad: requireUser,
	component: SignInReturnRoute,
});

function SignInReturnRoute() {
	const { workspace, bot: botId, oauth_error: oauthError } = signInReturnRoute.useSearch();
	const workspaces = useWorkspaces();
	const slug = workspaces.data?.find((one) => one.id === workspace)?.slug;
	const { bot, resolving: botResolving } = useBotOf(workspace, botId);
	const navigate = useNavigate();

	useEffect(() => {
		if (!bot || !slug) return;
		// Outside any workspace, so this names one; the link helpers are for pages inside.
		void navigate({
			to: "/$workspace/settings/bots/$bot/$page",
			params: { workspace: slug, bot: bot.handle, page: "connections" },
			search: { oauth_error: oauthError },
			replace: true,
		});
	}, [bot, slug, oauthError, navigate]);

	const resolving = workspace !== undefined && (botResolving || workspaces.isPending);
	if ((bot && slug) || resolving) {
		return <div className="h-full bg-list" />;
	}
	return (
		<div className="grid h-full place-items-center bg-list p-6">
			<EmptyState title="Connection sign-in failed">
				<p>
					{oauthError
						? signInFailureReason(oauthError)
						: "The bot it was for is no longer available to you."}
				</p>
				<Link to="/" className="text-link underline">
					Return to workspace
				</Link>
			</EmptyState>
		</div>
	);
}

/**
 * Where a bot's GitHub setup returns: the API names the bot, its GitHub app
 * once GitHub made it, and why setup stopped when it did.
 */
const gitHubSetupReturnRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: GITHUB_SETUP_RETURN_PATH,
	validateSearch: (search: Record<string, unknown>) => ({
		workspace: optionalString(search.workspace),
		bot: optionalString(search.bot),
		connection: optionalString(search.connection),
		github_error: optionalString(search.github_error),
	}),
	beforeLoad: requireUser,
	component: GitHubSetupReturnRoute,
});

function GitHubSetupReturnRoute() {
	const {
		workspace,
		bot: botId,
		connection,
		github_error: failure,
	} = gitHubSetupReturnRoute.useSearch();
	const workspaces = useWorkspaces();
	const slug = workspaces.data?.find((one) => one.id === workspace)?.slug;
	const { bot, resolving: botResolving } = useBotOf(workspace, botId);
	const navigate = useNavigate();

	useEffect(() => {
		if (failure || !slug || !bot || !connection) return;
		// Outside any workspace, so this names one; the link helpers are for pages inside.
		void navigate({
			to: "/$workspace/settings/bots/$bot/connections/$connection",
			params: { workspace: slug, bot: bot.handle, connection },
			replace: true,
		});
	}, [failure, slug, bot, connection, navigate]);

	const resolving = workspace !== undefined && (botResolving || workspaces.isPending);
	if ((!failure && slug && bot && connection) || resolving) {
		return <div className="h-full bg-list" />;
	}
	return (
		<div className="grid h-full place-items-center bg-list p-6">
			<EmptyState title="GitHub setup didn't finish">
				<p>{gitHubSetupFailureReason(failure)}</p>
				{slug && bot ? (
					<Link
						to="/$workspace/settings/bots/$bot"
						params={{ workspace: slug, bot: bot.handle }}
						className="text-link underline"
					>
						Back to {bot.name}
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

/**
 * The bot `botId` of `workspace`, for a page outside any workspace that the
 * API sent back with their ids.
 */
function useBotOf(workspace: string | undefined, botId: string | undefined) {
	const bots = useQuery(botsQuery(workspace));
	return {
		bot: bots.data?.find((one) => one.id === botId),
		resolving: bots.isPending,
	};
}

const GITHUB_SETUP_FAILURES: Record<GitHubSetupFailure, string> = {
	expired:
		"The link had expired, or was started by someone else. Start again from the bot's connections.",
	github: "GitHub refused or couldn't be reached. Try again in a moment.",
	cancelled:
		"It was cancelled on GitHub. Start again from the bot's connections when you're ready.",
};

function gitHubSetupFailureReason(failure: string | undefined) {
	return failure && failure in GITHUB_SETUP_FAILURES
		? GITHUB_SETUP_FAILURES[failure as GitHubSetupFailure]
		: "The bot it was for is no longer available to you.";
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
	const { isPending, failure, refetch } = useWorkspace();
	const workspaces = useWorkspaces();

	if (failure) {
		return <LoadFailure title="Could not start setup" error={failure.error} retry={refetch} />;
	}
	if (isPending) return <div className="h-full bg-list" />;
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

/** Where the workspace opens: the person's Personal Assistant, made first if they have none. */
const workspaceIndexRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/",
	loader: preloadChatScreenForWideLayout,
	component: AssistantRoute,
});

function AssistantRoute() {
	const { isPending, error } = useBots();
	const assistant = useAssistant();
	const ensure = useEnsureAssistant();
	const { mutate } = ensure;
	const missing = !isPending && !error && !assistant;
	useEffect(() => {
		if (missing) mutate(undefined);
	}, [missing, mutate]);
	if (assistant) return <Navigate {...botLink(assistant)} replace />;
	if (error || ensure.isError) {
		return (
			<Panes>
				<EmptyState title="Could not open your Personal Assistant">{API_DID_NOT_ANSWER}</EmptyState>
			</Panes>
		);
	}
	return <Panes>{null}</Panes>;
}

function ShellRoute() {
	const workspace = useWorkspace();
	const workspaces = useWorkspaces();
	const standing = useWorkspaceStanding();

	if (workspace.failure) {
		return (
			<LoadFailure
				title="Could not load your workspace"
				error={workspace.failure.error}
				retry={workspace.refetch}
			/>
		);
	}
	if (workspace.isPending) return <div className="h-full bg-list" />;
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
		const standingFailure = loadFailure(standing);
		if (standingFailure) {
			return (
				<LoadFailure
					title="Could not load your workspace"
					error={standingFailure.error}
					retry={standing.refetch}
				/>
			);
		}
		if (standing.isPending) return <div className="h-full bg-list" />;
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

const settingsChannelRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/channels/$channel",
	// The dialog waits for the rosters, so its code downloads alongside rather than after.
	loader: () => WorkspaceSettings.preload(),
	component: SettingsChannelRoute,
});

/** One of a channel's pages besides General: People or Bots. */
const settingsChannelPageRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/channels/$channel/$page",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsChannelPageRoute,
});

const settingsBotRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/bots/$bot",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsBotRoute,
});

/** One of a bot's pages besides its own: Connections or Computer. */
const settingsBotPageRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/bots/$bot/$page",
	validateSearch: (search: Record<string, unknown>): { oauth_error?: string } => ({
		oauth_error: optionalString(search.oauth_error),
	}),
	// A sign-in error shown for one bot must not follow you to the next.
	remountDeps: ({ params }) => [params.workspace, params.bot],
	loader: () => WorkspaceSettings.preload(),
	component: SettingsBotPageRoute,
});

/** One of a bot's connections, by its id. */
const settingsBotConnectionRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/bots/$bot/connections/$connection",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsBotConnectionRoute,
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

function SettingsChannelRoute() {
	const { channel: slug } = settingsChannelRoute.useParams();
	const { data: channels, isPending, error } = useChannels();
	// A channel's settings are for the people in it.
	const channel = memberChannel(channels, slug);
	if (isPending) return <SettingsLayout>{null}</SettingsLayout>;
	if (!channel) return <ChannelSettingsMissing channels={channels} slug={slug} error={error} />;
	return (
		<SettingsLayout>
			<WorkspaceSettings section="channels" selectedChannelId={channel.id} />
		</SettingsLayout>
	);
}

function SettingsChannelPageRoute() {
	const { channel: slug, page: pageSegment } = settingsChannelPageRoute.useParams();
	const { data: channels, isPending, error } = useChannels();
	const channel = memberChannel(channels, slug);
	const page = channelSettingsPage(pageSegment);
	if (!page) {
		return (
			<Navigate
				from="/$workspace"
				to="./settings/channels/$channel"
				params={{ channel: slug }}
				replace
			/>
		);
	}
	if (isPending) return <SettingsLayout>{null}</SettingsLayout>;
	if (!channel) return <ChannelSettingsMissing channels={channels} slug={slug} error={error} />;
	return (
		<SettingsLayout>
			<WorkspaceSettings section="channels" selectedChannelId={channel.id} channelPage={page} />
		</SettingsLayout>
	);
}

/**
 * Why a channel's settings are not shown: it could not be loaded, it is not
 * here, or the person is not in it, which a public channel's own page joins.
 */
function ChannelSettingsMissing({
	channels,
	slug,
	error,
}: {
	channels: readonly Channel[] | undefined;
	slug: string;
	error: unknown;
}) {
	const channel = findChannel(channels, slug);
	return (
		<Panes>
			{channel ? (
				<EmptyState title="You're not in this channel">
					Join it from its page to see its settings.
				</EmptyState>
			) : (
				<EmptyState title={error ? "Could not load this channel" : "No such channel here"} />
			)}
		</Panes>
	);
}

/** The channel at `slug` when the person is in it, as its settings need. */
function memberChannel(
	channels: readonly Channel[] | undefined,
	slug: string,
): Channel | undefined {
	const channel = findChannel(channels, slug);
	return channel?.isMember ? channel : undefined;
}

/** The bot at `handle` for a settings page, once found; while it loads nothing, and if missing, why. */
function SettingsBot({ handle, children }: { handle: string; children: (bot: Bot) => ReactNode }) {
	const { bot, isPending, error } = useBotWithHandle(handle);
	if (isPending) return <SettingsLayout>{null}</SettingsLayout>;
	if (!bot) {
		return (
			<Panes>
				<EmptyState title={error ? "Could not load this bot" : "No such bot here"} />
			</Panes>
		);
	}
	return <SettingsLayout>{children(bot)}</SettingsLayout>;
}

function SettingsBotRoute() {
	const { bot } = settingsBotRoute.useParams();
	return (
		<SettingsBot handle={bot}>
			{(bot) => <WorkspaceSettings section="bots" selectedBot={bot} />}
		</SettingsBot>
	);
}

function SettingsBotPageRoute() {
	const { bot, page: pageSegment } = settingsBotPageRoute.useParams();
	const { oauth_error: oauthError } = settingsBotPageRoute.useSearch();
	const navigate = settingsBotPageRoute.useNavigate();
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
	const page = botSettingsPage(pageSegment);
	if (!page) {
		return <Navigate from="/$workspace" to="./settings/bots/$bot" params={{ bot }} replace />;
	}
	return (
		<SettingsBot handle={bot}>
			{(bot) =>
				// A Personal Assistant's computer is ours to set up; its person changes its look and connections.
				bot.assistant && page === "computer" ? (
					<Navigate {...botSettingsLink(bot)} replace />
				) : (
					<WorkspaceSettings
						section="bots"
						selectedBot={bot}
						botPage={page}
						connectionSignInError={signInError && signInFailureReason(signInError)}
					/>
				)
			}
		</SettingsBot>
	);
}

function SettingsBotConnectionRoute() {
	const { bot, connection } = settingsBotConnectionRoute.useParams();
	return (
		<SettingsBot handle={bot}>
			{(bot) => (
				<WorkspaceSettings
					section="bots"
					selectedBot={bot}
					botPage="connections"
					selectedConnectionId={connection}
				/>
			)}
		</SettingsBot>
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
const inboxRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/inbox",
	component: () => (
		<Panes>
			<Inbox>
				<Outlet />
			</Inbox>
		</Panes>
	),
});

/** With nothing chosen, how much is unread sits beside the list; on a phone the list is the page. */
const inboxIndexRoute = createRoute({
	getParentRoute: () => inboxRoute,
	path: "/",
	component: InboxOverview,
});

type InboxConversationSearch = ConversationSearch;

const inboxConversationRoute = createRoute({
	getParentRoute: () => inboxRoute,
	path: "/$conversation",
	validateSearch: (search: Record<string, unknown>): InboxConversationSearch =>
		validateConversationSearch(search),
	preloadStaleTime: 0,
	loader: ({ context, params }) => {
		prefetchConversation(context.queries, params.conversation);
		return ConversationPage.preload();
	},
	component: () => {
		const { conversation } = inboxConversationRoute.useParams();
		const navigate = inboxConversationRoute.useNavigate();
		const changeItem = useItemChange((item, replace) =>
			navigate({ search: (previous) => ({ ...previous, item }), replace }),
		);
		const search = inboxConversationRoute.useSearch();
		return (
			<ConversationScreen place={useAnyConversationPlace(conversation)}>
				{(found, user) => (
					<InboxPane
						channel={found.channel}
						conversation={found.conversation}
						conversationId={conversation}
						user={user}
						itemPageId={search.itemPage}
						focusMessageId={search.message}
						itemConversationId={search.item}
						onItemPageChange={(itemPage) =>
							void navigate({ search: (previous) => ({ ...previous, itemPage }) })
						}
						onItemChange={changeItem}
						staged={stagedOf(search)}
						onStagedChange={(staged, how) =>
							void navigate({
								search: (previous) => ({ ...previous, ...stagedSearchOf(staged) }),
								...how,
							})
						}
					/>
				)}
			</ConversationScreen>
		);
	},
});

/**
 * Your direct messages with other people. The address names no channel, as a
 * direct message between people is in none. On a phone the list is the page
 * until one is open.
 */
const directMessagesRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/dm",
	component: DirectMessagesRoute,
});

function DirectMessagesRoute() {
	const matchRoute = useMatchRoute();
	const atList = Boolean(matchRoute({ to: directMessagesRoute.fullPath }));
	return (
		<>
			{atList && <MobileDirectMessages className="md:hidden" />}
			<Panes className={atList ? "max-md:hidden" : undefined}>
				<Outlet />
			</Panes>
		</>
	);
}

/** Beside the sidebar while none is open: a way to start one. */
const directMessagesIndexRoute = createRoute({
	getParentRoute: () => directMessagesRoute,
	path: "/",
	component: DirectMessagesOverview,
});

/** Starting a direct message: whom to, and the first message. */
const newDirectMessageRoute = createRoute({
	getParentRoute: () => directMessagesRoute,
	path: "/new",
	component: () => <NewDirectMessagePage />,
});

interface DirectMessageSearch extends ConversationSearch {
	/** A message to jump to, such as the one a notification is about. */
	message?: string;
}

const directMessageRoute = createRoute({
	getParentRoute: () => directMessagesRoute,
	path: "/$conversation",
	validateSearch: (search: Record<string, unknown>): DirectMessageSearch => ({
		...validateConversationSearch(search),
		...idParam(search, "message"),
	}),
	preloadStaleTime: 0,
	loader: ({ context, params }) => {
		prefetchConversation(context.queries, params.conversation);
		return ConversationPage.preload();
	},
	component: () => {
		const { conversation } = directMessageRoute.useParams();
		const navigate = directMessageRoute.useNavigate();
		const changeItem = useItemChange((item, replace) =>
			navigate({ search: (previous) => ({ ...previous, item }), replace }),
		);
		const search = directMessageRoute.useSearch();
		return (
			<ConversationScreen place={useDirectMessage(conversation)}>
				{(found, user) => (
					<ConversationPage
						conversation={found.conversation}
						channel={found.channel}
						conversationId={conversation}
						user={user}
						itemConversationId={search.item}
						focusMessageId={search.message}
						onItemChange={changeItem}
						staged={stagedOf(search)}
						onStagedChange={(staged, how) =>
							void navigate({
								search: (previous) => ({ ...previous, ...stagedSearchOf(staged) }),
								...how,
							})
						}
					/>
				)}
			</ConversationScreen>
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

/**
 * You on a phone, where the sidebar's foot has no room: your workspace, its
 * settings, and signing out. A wider screen, as a window widened from a phone's
 * size, has settings of its own, which it goes to in this page's place.
 */
const youRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/you",
	component: () => {
		const wide = useMediaQuery(SIDE_BY_SIDE);
		if (wide) return <Navigate from="/$workspace" to="./settings" replace />;
		return (
			<Panes>
				<You />
			</Panes>
		);
	},
});

/** Every channel the person is in or could join, and making another. */
const channelsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/channels",
	component: () => (
		<Panes>
			<ChannelsDirectory />
		</Panes>
	),
});

/** Every bot the person reaches, pinning them to the sidebar, and making another. */
const botsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/bots",
	component: () => (
		<Panes>
			<BotsDirectory />
		</Panes>
	),
});

/** On a phone, Home: the Personal Assistant, the channels and the pinned bots. */
const homeRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/home",
	component: () => {
		const wide = useMediaQuery(SIDE_BY_SIDE);
		if (wide) return <Navigate from="/$workspace" to="." replace />;
		return <MobileHome />;
	},
});

const channelRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/channels/$channel",
	loader: preloadChatScreenForWideLayout,
	component: ChannelRoute,
});

/** A channel's page beside the sidebar. */
function ChannelRoute() {
	const { channel: slug } = channelRoute.useParams();
	const { data: channels, isPending, error } = useChannels();
	const channel = findChannel(channels, slug);
	if (isPending) return <Panes>{null}</Panes>;
	if (!channel) {
		return (
			<Panes>
				<EmptyState title={error ? "Could not load this channel" : "No such channel here"}>
					{error
						? "The API did not answer. Reload, or check that it is running."
						: "It may have been removed, or it is private and you're not in it."}
				</EmptyState>
			</Panes>
		);
	}
	// A public channel the person isn't in, opened by its address: what it is, and Join.
	if (!channel.isMember) {
		return (
			<Panes>
				<JoinChannel channel={channel} />
			</Panes>
		);
	}
	return (
		<Panes>
			<Outlet />
		</Panes>
	);
}

/** A channel the person isn't in: its name and what it's for, with Join where they may. */
function JoinChannel({ channel }: { channel: Channel }) {
	const join = useJoinChannel();
	return (
		<EmptyState title={channel.name}>
			<span className="flex flex-col items-center gap-3">
				<span>{channel.description ?? "You're not in this channel yet."}</span>
				{channel.permissions.join ? (
					<Button disabled={join.isPending} onClick={() => join.mutate(channel.id)}>
						Join {channel.name}
					</Button>
				) : (
					<span>Ask someone in it to add you.</span>
				)}
				{join.isError && <span role="alert">{failureMessage(join.error)}</span>}
			</span>
		</EmptyState>
	);
}

/** A channel opened without a conversation chosen opens its main chat, opened first if nobody has. */
const channelIndexRoute = createRoute({
	getParentRoute: () => channelRoute,
	path: "/",
	loader: () => ConversationPage.preload(),
	component: () => {
		const channel = findChannel(useChannels().data, channelIndexRoute.useParams().channel);
		return channel ? <OpenChannelConversation channel={channel} /> : null;
	},
});

function OpenChannelConversation({ channel }: { channel: Channel }) {
	const opened = useOpenChannelConversation(channel);
	if (opened.isError) {
		return <EmptyState title="Could not open this channel">{API_DID_NOT_ANSWER}</EmptyState>;
	}
	if (!opened.data) return null;
	return <Navigate {...conversationLink({ channel, conversationId: opened.data.id })} replace />;
}

/**
 * Where a page opens its conversation beside the sidebar. On a phone, touching a chat's
 * link preloads it instead, through the conversation route's loader.
 */
function preloadChatScreenForWideLayout() {
	if (matchesMedia(SIDE_BY_SIDE)) ConversationPage.preload();
}

const channelFilesRoute = createRoute({
	getParentRoute: () => channelRoute,
	path: "/files",
	component: () => {
		const channel = findChannel(useChannels().data, channelFilesRoute.useParams().channel);
		return channel ? <FilesPage owner={{ channel }} /> : null;
	},
});

const channelFileRoute = createRoute({
	getParentRoute: () => channelRoute,
	path: "/files/$file",
	validateSearch: (search: Record<string, unknown>) => validateFileSearch(search),
	component: () => {
		const { channel: slug, file } = channelFileRoute.useParams();
		const { version } = channelFileRoute.useSearch();
		const channel = findChannel(useChannels().data, slug);
		return channel ? <FilesPage owner={{ channel }} selectedId={file} version={version} /> : null;
	},
});

/** A channel's main chat or one of its threads. */
const channelConversationRoute = createRoute({
	getParentRoute: () => channelRoute,
	path: "/$conversation",
	validateSearch: (search: Record<string, unknown>) => validateConversationSearch(search),
	// On every hover, not once per 30 s: the query cache, not the router,
	// decides what of the conversation is still fresh.
	preloadStaleTime: 0,
	// Also run while the pointer is on a link here, so it is loading before the click.
	loader: ({ context, params }) => {
		prefetchConversation(context.queries, params.conversation);
		return ConversationPage.preload();
	},
	component: () => {
		const { channel, conversation } = channelConversationRoute.useParams();
		const navigate = channelConversationRoute.useNavigate();
		const search = channelConversationRoute.useSearch();
		return (
			<ConversationScreen place={useChannelConversationPlace(channel, conversation)}>
				{(found, user) => (
					<RoutedConversation
						found={found}
						conversationId={conversation}
						user={user}
						search={search}
						navigate={(change) => void navigate(change)}
					/>
				)}
			</ConversationScreen>
		);
	},
});

const botRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/bots/$bot",
	loader: preloadChatScreenForWideLayout,
	component: BotRoute,
});

/** A bot's page beside the sidebar. */
function BotRoute() {
	const { bot: handle } = botRoute.useParams();
	const { bot, isPending, error } = useBotWithHandle(handle);
	const onAutomations = useMatch({ from: automationsRoute.id, shouldThrow: false }) !== undefined;
	if (isPending) return <Panes>{null}</Panes>;
	if (!bot) {
		return (
			<Panes>
				<EmptyState title={error ? "Could not load this bot" : "No such bot here"}>
					{error
						? "The API did not answer. Reload, or check that it is running."
						: "It may have been removed or renamed, or it is someone else's private bot."}
				</EmptyState>
			</Panes>
		);
	}
	// Someone else's private bot, which an administrator sees listed: it exists, and its settings
	// and automations are theirs to manage, though its tasks and what its automations posted are not.
	if (!bot.permissions.talk && !(bot.permissions.manageAutomations && onAutomations)) {
		return (
			<Panes>
				<EmptyState title={bot.name}>
					<span className="flex flex-col items-center gap-3">
						<span>This is someone else's private bot, so its tasks are theirs alone.</span>
						{bot.permissions.update && (
							<Link {...botSettingsLink(bot)} className="text-link underline">
								Open its settings
							</Link>
						)}
						{bot.permissions.manageAutomations && (
							<Link {...automationsLink(bot)} className="text-link underline">
								Open its automations
							</Link>
						)}
					</span>
				</EmptyState>
			</Panes>
		);
	}
	return (
		<Panes>
			<Outlet />
		</Panes>
	);
}

/** The bot whose page a route under `/bots/$bot` is on, once the roster has it. */
function useRoutedBot(handle: string): Bot | undefined {
	return useBotWithHandle(handle).bot;
}

/** A bot opened without a task chosen opens its newest open task, or a new one where there is room. */
const botIndexRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/",
	component: () => {
		const bot = useRoutedBot(botIndexRoute.useParams().bot);
		return bot ? <OpenNewestTask bot={bot} /> : null;
	},
});

function OpenNewestTask({ bot }: { bot: Bot }) {
	const { data: list, isError } = useBotTasks(bot.id);
	if (isError)
		return <EmptyState title="Could not load this bot's tasks">{API_DID_NOT_ANSWER}</EmptyState>;
	if (!list) return null;
	const newest = list.tasks.find((task) => task.conversation.doneAt === null);
	return newest ? (
		<Navigate {...conversationLink({ bot, conversationId: newest.conversation.id })} replace />
	) : (
		<Navigate {...newTaskLink(bot)} replace />
	);
}

/** Starting a task with the bot, from its first message. */
const newTaskRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/new",
	component: () => {
		const bot = useRoutedBot(newTaskRoute.useParams().bot);
		const { user } = useSession();
		return bot && user ? <NewTask key={bot.id} bot={bot} userId={user.id} /> : null;
	},
});

/** One of the bot's tasks, or one of its automations' feeds. */
const taskRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/tasks/$conversation",
	validateSearch: (search: Record<string, unknown>) => validateConversationSearch(search),
	preloadStaleTime: 0,
	loader: ({ context, params }) => {
		prefetchConversation(context.queries, params.conversation);
		return ConversationPage.preload();
	},
	component: () => {
		const { bot: handle, conversation } = taskRoute.useParams();
		const bot = useRoutedBot(handle);
		return bot ? <BotConversation bot={bot} conversationId={conversation} /> : null;
	},
});

function BotConversation({ bot, conversationId }: { bot: Bot; conversationId: string }) {
	const navigate = taskRoute.useNavigate();
	const search = taskRoute.useSearch();
	return (
		<ConversationScreen place={useBotConversationPlace(bot, conversationId)}>
			{(found, user) => (
				<RoutedConversation
					found={found}
					conversationId={conversationId}
					user={user}
					search={search}
					navigate={(change) => void navigate(change)}
				/>
			)}
		</ConversationScreen>
	);
}

const botFilesRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/files",
	component: () => {
		const bot = useRoutedBot(botFilesRoute.useParams().bot);
		return bot ? <FilesPage owner={{ bot }} /> : null;
	},
});

const botFileRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/files/$file",
	validateSearch: (search: Record<string, unknown>) => validateFileSearch(search),
	component: () => {
		const { bot: handle, file } = botFileRoute.useParams();
		const { version } = botFileRoute.useSearch();
		const bot = useRoutedBot(handle);
		return bot ? <FilesPage owner={{ bot }} selectedId={file} version={version} /> : null;
	},
});

/** A task by its id alone, as a notification names it, which goes on to its bot's address. */
const taskByIdRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/tasks/$conversation",
	component: () => {
		const { conversation } = taskByIdRoute.useParams();
		const search = useSearch({ strict: false });
		const { found, isPending, error } = useAnyConversationPlace(conversation);
		if (isPending) return <Panes>{null}</Panes>;
		const bot = found?.conversation.kind === "botConversation" ? found.conversation.bot : undefined;
		if (!bot) {
			return (
				<Panes>
					<EmptyState title={error ? "Could not load this task" : "Task not found"} />
				</Panes>
			);
		}
		return (
			<Navigate
				{...conversationLink({ bot, conversationId: conversation })}
				search={search as ConversationSearch}
				replace
			/>
		);
	},
});

interface FileSearch {
	/** An earlier version to show; the current one when absent. */
	version?: number;
}

const validateFileSearch = (search: Record<string, unknown>): FileSearch =>
	typeof search.version === "number" && Number.isInteger(search.version) && search.version > 0
		? { version: search.version }
		: {};

interface ConversationSearch {
	/** A collaboration or automation run open beside the chat. */
	item?: string;
	/** A file open large beside the chat, in place of the conversation list. */
	file?: string;
	/** An earlier version of `file` to show; the current one when absent. */
	version?: number;
	/** The bot's computer's desktop open large beside the chat, when no file is. */
	desktop?: true;
	/**
	 * The bot's automations open large beside the chat, when nothing else is: all
	 * of them, one by its id, or a new one being made.
	 */
	automations?: string;
	/** The bot's tasks open large beside the chat, those still going or those done, when nothing else is. */
	tasks?: TasksTab;
	/** A message to jump to in the conversation, such as the mention a notification is about. */
	message?: string;
	/** An automation run or collaboration shown as the page itself, in place of the conversation. */
	itemPage?: string;
}

const validateConversationSearch = (search: Record<string, unknown>): ConversationSearch => {
	const { file } = idParam(search, "file");
	return {
		...idParam(search, "item"),
		...idParam(search, "message"),
		...idParam(search, "itemPage"),
		...(file
			? { file, ...validateFileSearch(search) }
			: search.desktop === true
				? { desktop: true }
				: typeof search.automations === "string" && isAutomationsView(search.automations)
					? { automations: search.automations }
					: search.tasks === "open" || search.tasks === "done"
						? { tasks: search.tasks }
						: {}),
	};
};

/** How the address says which of a bot's automations are open beside its chat. */
const ALL_AUTOMATIONS = "all";
const NEW_AUTOMATION = "new";

const isAutomationsView = (value: string) =>
	value === ALL_AUTOMATIONS || value === NEW_AUTOMATION || isUuid(value);

const automationsViewFromSearch = (value: string): AutomationsView =>
	value === NEW_AUTOMATION
		? { kind: "new" }
		: value === ALL_AUTOMATIONS
			? { kind: "list" }
			: { kind: "automation", automationId: value };

const automationsViewSearch = (view: AutomationsView): string =>
	view.kind === "new" ? NEW_AUTOMATION : view.kind === "list" ? ALL_AUTOMATIONS : view.automationId;

/** What `search` opens beside a chat, and the search that opens `staged`. */
const stagedOf = (search: ConversationSearch): Staged | undefined =>
	search.file
		? { kind: "file", fileId: search.file, version: search.version }
		: search.desktop
			? { kind: "desktop" }
			: search.automations
				? { kind: "automations", view: automationsViewFromSearch(search.automations) }
				: search.tasks
					? { kind: "tasks", tab: search.tasks }
					: undefined;

const stagedSearchOf = (staged: Staged | undefined): ConversationSearch => ({
	file: staged?.kind === "file" ? staged.fileId : undefined,
	version: staged?.kind === "file" ? staged.version : undefined,
	desktop: staged?.kind === "desktop" ? true : undefined,
	automations: staged?.kind === "automations" ? automationsViewSearch(staged.view) : undefined,
	tasks: staged?.kind === "tasks" ? staged.tab : undefined,
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

/** A bot's automations, with the one chosen beside them: its feed, where its runs post. */
const automationsRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/automations",
	component: () => {
		const { bot: handle } = automationsRoute.useParams();
		const { automation } = useParams({ strict: false });
		const making = useMatch({ from: newAutomationRoute.id, shouldThrow: false }) !== undefined;
		const bot = useRoutedBot(handle);
		return bot ? (
			<AutomationsPage bot={bot} selectedAutomationId={automation} making={making}>
				<Outlet />
			</AutomationsPage>
		) : null;
	},
});

/** An automation being made, beside the bot's automations. */
const newAutomationRoute = createRoute({
	getParentRoute: () => automationsRoute,
	path: "/new",
	component: () => {
		const bot = useRoutedBot(newAutomationRoute.useParams().bot);
		return bot ? <NewAutomation bot={bot} /> : null;
	},
});

/** With none chosen, the bot's first automation opens beside the list; on a phone the list is the page. */
const automationsIndexRoute = createRoute({
	getParentRoute: () => automationsRoute,
	path: "/",
	component: () => {
		const bot = useRoutedBot(automationsIndexRoute.useParams().bot);
		const sideBySide = useMediaQuery(SIDE_BY_SIDE);
		if (!bot || !sideBySide) return null;
		return <OpenFirstAutomation bot={bot} />;
	},
});

function OpenFirstAutomation({ bot }: { bot: Bot }) {
	const first = useListedAutomations(bot).automations?.[0];
	if (!first) return null;
	return <Navigate {...automationFeedLink(bot, first.automation.id)} replace />;
}

/** An automation's feed, opened first if it has none, beside the bot's automations. */
const automationFeedRoute = createRoute({
	getParentRoute: () => automationsRoute,
	path: "/$automation",
	validateSearch: validateConversationSearch,
	loader: () => ConversationPage.preload(),
	component: () => {
		const { bot: handle, automation } = automationFeedRoute.useParams();
		const bot = useRoutedBot(handle);
		if (!bot) return null;
		// Somebody who manages the bot without reaching it sees how the automation is set up, not its feed.
		return bot.permissions.talk ? (
			<AutomationFeed key={automation} bot={bot} automationId={automation} />
		) : (
			<AutomationSetup key={automation} bot={bot} automationId={automation} />
		);
	},
});

/** The automation's feed, opened first when it has none, as a chat beside the automations. */
function AutomationFeed({ bot, automationId }: { bot: Bot; automationId: string }) {
	const opened = useOpenAutomationFeed(bot.id, automationId);
	const navigate = automationFeedRoute.useNavigate();
	const search = automationFeedRoute.useSearch();
	if (opened.isError) {
		return (
			<EmptyState title="Could not open this automation">
				It may have been removed. Reload this page to try again.
			</EmptyState>
		);
	}
	if (!opened.data) return null;
	const conversationId = opened.data.id;
	return (
		<BotConversationScreen bot={bot} conversationId={conversationId}>
			{(found, user) => (
				<RoutedConversation
					found={found}
					conversationId={conversationId}
					user={user}
					search={search}
					navigate={(change) => void navigate(change)}
				/>
			)}
		</BotConversationScreen>
	);
}

const API_DID_NOT_ANSWER = "The API did not answer. Reload this page to try again.";

/** What a conversation's address says to open beside it, and how a page changes it. */
type SearchChange = {
	search: (previous: ConversationSearch) => ConversationSearch;
	replace?: boolean;
};

/**
 * A conversation at its own address, in a channel or a bot's, keeping what
 * the address opens beside it in step with the page.
 */
function RoutedConversation({
	found,
	conversationId,
	user,
	search,
	navigate,
}: {
	found: ConversationPlace;
	conversationId: string;
	user: SessionUser;
	search: ConversationSearch;
	navigate: (change: SearchChange) => void;
}) {
	const changeItem = useItemChange((item, replace) =>
		navigate({ search: (previous) => ({ ...previous, item }), replace }),
	);
	// A run or collaboration a notification names is the page itself, with the way back to where it is.
	if (search.itemPage) {
		const openClassName = cn(
			buttonStyles({ variant: "outline", size: "sm" }),
			"shrink-0 max-md:hidden",
		);
		return (
			<ItemConversationPage
				bot={placeBot(found)}
				conversationId={conversationId}
				itemConversationId={search.itemPage}
				back={
					found.channel !== null
						? { to: "channel", channel: found.channel }
						: { to: "bot", bot: found.conversation.bot }
				}
				trailing={
					found.channel !== null ? (
						<Link
							{...conversationLink({ channel: found.channel, conversationId })}
							className={openClassName}
						>
							Open conversation
						</Link>
					) : (
						<Link
							{...conversationLink({ bot: found.conversation.bot, conversationId })}
							className={openClassName}
						>
							Open conversation
						</Link>
					)
				}
				onOpenItem={(itemPage) => navigate({ search: (previous) => ({ ...previous, itemPage }) })}
			/>
		);
	}
	return (
		<ConversationPage
			conversation={found.conversation}
			channel={found.channel}
			conversationId={conversationId}
			user={user}
			itemConversationId={search.item}
			focusMessageId={search.message}
			onItemChange={changeItem}
			staged={stagedOf(search)}
			onStagedChange={(staged, how) =>
				navigate({ search: (previous) => ({ ...previous, ...stagedSearchOf(staged) }), ...how })
			}
		/>
	);
}

/** The conversation `conversationId` of the bot `bot`'s, for a screen of it; see `ConversationScreen`. */
function BotConversationScreen({
	bot,
	conversationId,
	children,
}: {
	bot: Bot;
	conversationId: string;
	children: (found: ConversationPlace, user: SessionUser) => ReactNode;
}) {
	return (
		<ConversationScreen place={useBotConversationPlace(bot, conversationId)}>
			{children}
		</ConversationScreen>
	);
}

/**
 * A screen of a conversation, once `place` has found where it is and who it
 * is with; while it loads nothing, and if it cannot be found, why.
 */
function ConversationScreen<Place>({
	place: { found, isPending, error },
	children,
}: {
	place: { found: Place | undefined; isPending: boolean; error: unknown };
	children: (found: Place, user: SessionUser) => ReactNode;
}) {
	const { user } = useSession();

	if (isPending) return null;
	if (!found) {
		return (
			// Lifted a little above the middle, as a channel's empty pages are.
			<div className="flex min-h-0 flex-1 pb-20">
				<EmptyState
					title={error ? "Could not load this conversation" : "Conversation not found"}
					icon={<MessageSquareOff strokeWidth={1.75} />}
				>
					{error
						? "Reload the page, or check that the API is running."
						: "It was removed, or you're not in it."}
				</EmptyState>
			</div>
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
		settingsChannelRoute,
		settingsChannelPageRoute,
		settingsBotRoute,
		settingsBotPageRoute,
		settingsBotConnectionRoute,
		settingsSystemModelRoute,
		settingsDefaultModelRoute,
		settingsProviderRoute,
		inboxRoute.addChildren([inboxIndexRoute, inboxConversationRoute]),
		approvalsRoute.addChildren([approvalsIndexRoute, approvalRoute]),
		directMessagesRoute.addChildren([
			directMessagesIndexRoute,
			newDirectMessageRoute,
			directMessageRoute,
		]),
		youRoute,
		homeRoute,
		channelsRoute,
		botsRoute,
		taskByIdRoute,
		channelRoute.addChildren([
			channelIndexRoute,
			channelFilesRoute,
			channelFileRoute,
			channelConversationRoute,
		]),
		botRoute.addChildren([
			botIndexRoute,
			newTaskRoute,
			taskRoute,
			botFilesRoute,
			botFileRoute,
			automationsRoute.addChildren([
				automationsIndexRoute,
				newAutomationRoute,
				automationFeedRoute,
			]),
		]),
	]),
]);

/**
 * Which way a phone slides from one page to the next, as a view transition's
 * type: `forward` into a page further in, as a channel opened from Home or a
 * thread from its channel, and `back` out of one. Switching tabs, or a change
 * that stays on its page, such as opening a bot's computer, does not slide.
 */
function phoneSlide({
	fromLocation,
	toLocation,
	hrefChanged,
}: {
	fromLocation?: ParsedLocation;
	toLocation: ParsedLocation;
	hrefChanged: boolean;
}): string[] | false {
	if (!fromLocation || !hrefChanged || matchesMedia(SIDE_BY_SIDE)) return false;
	const fromIndex = historyIndex(fromLocation);
	const toIndex = historyIndex(toLocation);
	const from = locationDepth(fromLocation);
	const to = locationDepth(toLocation);
	// In place: a page that sends on to its own address, as a bot's chat does, doesn't
	// slide, but Back from a page opened first, which goes up in its place, does.
	if (toIndex === fromIndex) return to < from ? ["back"] : false;
	if (to !== from) return [to > from ? "forward" : "back"];
	// A tab for another tab.
	if (to === 0) return false;
	// Pages as deep as each other, as a bot's channel and a thread in it both are: a step
	// through history tells which way, a page opened going forward and Back going back.
	return [toIndex > fromIndex ? "forward" : "back"];
}

/**
 * Opens a run or collaboration over a chat, or closes it, with `go`, which
 * names it in the address. On a phone an item covers its chat as a page of its
 * own, so closing one shows its chat: back to it when the chat is the page
 * behind, else the chat in the item's place, as when the item was opened from
 * Inbox. Opening the chat as a page after the item would have the chat's own
 * Back return to the item.
 */
function useItemChange(go: (item: string | undefined, replace: boolean) => void) {
	const { leaveFor } = useLeave();
	const { pathname } = useLocation();
	return (item: string | undefined) => {
		if (item !== undefined || matchesMedia(SIDE_BY_SIDE)) {
			go(item, false);
			return;
		}
		leaveFor(
			(page) => page.pathname === pathname && page.search.item === undefined,
			() => go(undefined, true),
		);
	};
}

/** Whether `pathname` is one of the settings, or a phone's You tab, which lists them. */
function isSettingsPath(pathname: string): boolean {
	const [section] = pathname.split("/").filter(Boolean).slice(1);
	return section === "settings" || section === "you";
}

/**
 * A page's depth, and a step more while an item is open over it: a run or
 * collaboration opened from a chat or from Inbox, which the address names in
 * its search rather than its path.
 */
function locationDepth(location: ParsedLocation): number {
	const search = location.search as { item?: unknown; itemPage?: unknown };
	const itemOpen = search.item !== undefined || search.itemPage !== undefined;
	return pageDepth(location.pathname) + (itemOpen ? 1 : 0);
}

/**
 * How far into the app a page is on a phone: a tab is 0; what it opens, 1; and
 * so on. A bot's task is a step past the bot's chat, though its address is
 * no longer, so depth is told from what the address names, not its length.
 */
function pageDepth(pathname: string): number {
	// The workspace's own part of the address is the same everywhere, so it counts for nothing.
	const [section, ...rest] = pathname.split("/").filter(Boolean).slice(1);
	switch (section) {
		case "channels":
		case "bots": {
			// channels/$channel or bots/$bot is one in; what those open, two; files/$file or tasks/$task, three.
			const [, place, item] = rest;
			if (rest.length === 0) return 0;
			if (place === undefined) return 1;
			return item === undefined ? 2 : 3;
		}
		case "tasks":
			return 2;
		case "inbox":
		case "approvals":
		case "dm":
			return rest.length === 0 ? 0 : 1;
		case "you":
		case "home":
			return 0;
		case "settings":
			// Opened from You, so one in at least, and a step more for each part of the address.
			return 1 + rest.length;
		default:
			return 0;
	}
}

export function createAppRouter(options?: {
	history?: RouterHistory;
	/** Off where nothing watches the page slide, as in stories, so a quick redirect can't interrupt one. */
	defaultViewTransition?: false;
}) {
	const router = createRouter({
		routeTree,
		// Supplied by `RouterProvider` once the session is known.
		context: undefined as unknown as RouterContext,
		defaultPreload: "intent",
		// On a phone, a page further in slides over the one it was opened from, and back slides it away.
		defaultViewTransition: { types: phoneSlide },
		// Back to a list of settings returns to where it was left, not its top. Only settings:
		// a chat opens at its latest instead. What scrolls is named by `data-scroll-restoration-id`.
		scrollRestoration: ({ location }) => isSettingsPath(location.pathname),
		// A boundary for every route, so a failed page is replaced inside its parent and the sidebar
		// stays. The router's own boundary is above the root.
		defaultErrorComponent: PageFailure,
		// Tests mount the real tree over a memory history, so a route's guards
		// and search params are exercised rather than mocked around.
		...options,
	});
	// So Back can tell where going back would land.
	followTrail(router);
	return router;
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

import type { Workspace, WorkspacePermissions } from "@sugabots/contracts";
import { createRoute, Navigate } from "@tanstack/react-router";
import { useAssistant, useBots, useEnsuringAssistantFailed } from "@/lib/bots.ts";
import { API_DID_NOT_ANSWER } from "@/lib/failure.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { loadFailure } from "@/lib/query.ts";
import { useWorkspace, useWorkspaceStanding, useWorkspaces } from "@/lib/workspace.ts";
import { LoadFailure } from "@/shell/LoadFailure.tsx";
import { MobileHome } from "@/shell/MobileHome.tsx";
import { Panes, Shell } from "@/shell/Shell.tsx";
import { Splash } from "@/shell/Splash.tsx";
import { You } from "@/shell/You.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { preloadChatScreenForWideLayout } from "./chat.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { requireSignedIn, rootRoute } from "./root.tsx";

const NewChatPage = lazyNamed(() => import("@/screens/NewChatPage.tsx"), "NewChatPage");

export const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	beforeLoad: requireSignedIn,
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
	if (isPending) return <Splash />;
	if (!chosen) return <Navigate to="/workspace-setup" replace />;
	if (chosen.setUpAt === null && standing.isPending) {
		return <Splash />;
	}
	const setUp = workspaces.data?.find((one) => one.setUpAt !== null);
	const landing =
		setUp && opensIntoWorkspaceSetup(chosen, standing.data?.permissions) ? setUp : chosen;
	return <Navigate to="/$workspace" params={{ workspace: landing.slug }} replace />;
}

/** The frame, for the workspace the address names. */
export const shellRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/$workspace",
	beforeLoad: requireSignedIn,
	component: ShellRoute,
});

/**
 * Where the workspace opens: the person's Personal Assistant's page, where
 * something new is asked of it, made first if they have none. It is shown
 * here rather than at the assistant's own address, so the sidebar beside it
 * stays the workspace's.
 */
export const workspaceIndexRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/",
	loader: preloadChatScreenForWideLayout,
	component: AssistantRoute,
});

function AssistantRoute() {
	const { error } = useBots();
	const assistant = useAssistant();
	// The shell makes the assistant when the person has none; this shows whether that failed.
	const ensureFailed = useEnsuringAssistantFailed();
	if (assistant) {
		return (
			<Panes>
				<NewChatPage key={assistant.id} owner={{ bot: assistant }} />
			</Panes>
		);
	}
	if (error || ensureFailed) {
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
	if (workspace.isPending) return <Splash />;
	if (!workspace.workspace) {
		// Somebody in no workspace at all has one to make, not a wrong address.
		return workspaces.data?.length === 0 ? (
			<Navigate to="/workspace-setup" replace />
		) : (
			<EmptyState title="No such workspace here" />
		);
	}
	if (workspace.workspace.setUpAt === null) {
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
		if (standing.isPending) return <Splash />;
		if (opensIntoWorkspaceSetup(workspace.workspace, standing.data?.permissions)) {
			return (
				<Navigate to="/workspace-setup" search={{ workspace: workspace.workspace.slug }} replace />
			);
		}
	}
	return <Shell />;
}

/**
 * Whether opening `workspace` takes the caller into its setup instead: it is
 * still being set up, and they may finish it, which takes
 * `workspace.providers.manage`.
 */
function opensIntoWorkspaceSetup(
	workspace: Workspace,
	permissions: WorkspacePermissions | undefined,
): boolean {
	return workspace.setUpAt === null && permissions?.manageProviders === true;
}

/**
 * You on a phone, where the sidebar's foot has no room: your workspace, its
 * settings, and signing out. A wider screen, as a window widened from a phone's
 * size, has settings of its own, which it goes to in this page's place.
 */
export const youRoute = createRoute({
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

/** On a phone, Home: the Personal Assistant, the projects and the pinned bots. */
export const homeRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/home",
	component: () => {
		const wide = useMediaQuery(SIDE_BY_SIDE);
		if (wide) return <Navigate from="/$workspace" to="." replace />;
		return <MobileHome />;
	},
});

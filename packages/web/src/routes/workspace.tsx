import type { Workspace, WorkspacePermissions } from "@sugabots/contracts";
import { createRoute, Navigate, useSearch } from "@tanstack/react-router";
import { ownAssistants, useBots, useCreateAssistant } from "@/lib/bots.ts";
import { failureMessage } from "@/lib/failure.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { settingsSearchValue, validateSettingsSearch } from "@/lib/open-settings.ts";
import { loadFailure } from "@/lib/query.ts";
import { useWorkspace, useWorkspaceStanding, useWorkspaces } from "@/lib/workspace.ts";
import { LoadFailure } from "@/shell/LoadFailure.tsx";
import { MobileHome } from "@/shell/MobileHome.tsx";
import { Panes, Shell } from "@/shell/Shell.tsx";
import { Splash } from "@/shell/Splash.tsx";
import { You } from "@/shell/You.tsx";
import { Button } from "@/ui/button.tsx";
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
	// Settings open over any page in the workspace, so every one of them can name them.
	validateSearch: validateSettingsSearch,
	component: ShellRoute,
});

/**
 * Where the workspace opens: the member's oldest Personal Assistant's page,
 * where something new is asked of it, or, for a member with none, a way to
 * make one. Nothing makes one for them unasked. It is shown
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
	const { bots, isPending, error, refetch } = useBots();
	const [assistant] = ownAssistants(bots);
	if (assistant) {
		return (
			<Panes>
				<NewChatPage key={assistant.id} owner={{ bot: assistant }} />
			</Panes>
		);
	}
	if (error) {
		return (
			<Panes>
				<LoadFailure title="Could not open your Personal Assistant" error={error} retry={refetch} />
			</Panes>
		);
	}
	if (isPending) {
		return (
			<Panes>
				<EmptyState title="Opening your Personal Assistant…" />
			</Panes>
		);
	}
	return (
		<Panes>
			<NoAssistant />
		</Panes>
	);
}

/** The workspace's home for a member with no Personal Assistant: a way to make one. */
function NoAssistant() {
	const create = useCreateAssistant();
	return (
		<EmptyState
			title="You have no Personal Assistant"
			page="min"
			actions={
				<Button disabled={create.isPending} onClick={() => create.mutate()}>
					Make a Personal Assistant
				</Button>
			}
		>
			{create.error
				? failureMessage(create.error)
				: "Make one to find your way around the workspace."}
		</EmptyState>
	);
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
 * size, has a settings dialog instead, which it opens over the workspace's
 * home in this page's place, at whichever page of them was open.
 */
export const youRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/you",
	component: function YouRoute() {
		const wide = useMediaQuery(SIDE_BY_SIDE);
		const settings = useSearch({ from: "/$workspace", select: (search) => search.settings });
		if (wide) {
			return (
				<Navigate
					from="/$workspace"
					to="."
					search={{ settings: settings ?? settingsSearchValue({ kind: "sections" }) }}
					replace
				/>
			);
		}
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
		if (wide) return <Navigate from="/$workspace" to="." search={true} replace />;
		return <MobileHome />;
	},
});

import {
	CONNECTOR_SIGN_IN_RETURN_PATH,
	GITHUB_SETUP_RETURN_PATH,
	type GitHubSetupFailure,
} from "@sugabots/contracts";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { botsQuery } from "@/lib/bots.ts";
import { signInFailureReason } from "@/lib/connectors.ts";
import { ownerOfProject } from "@/lib/owner-of-project.ts";
import { projectsQuery } from "@/lib/projects.ts";
import { ownerName, type ResourceOwner } from "@/lib/resource-owner.tsx";
import { useWorkspaces } from "@/lib/workspace.ts";
import { Splash } from "@/shell/Splash.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { requireSignedIn, rootRoute } from "./root.tsx";
import { optionalString } from "./search.ts";

interface SignInReturnSearch {
	workspace?: string;
	/** The project the connector is of, which may be a bot's default project. */
	project?: string;
	/** A code saying why the sign-in did not finish, shown only through `signInFailureReason`. */
	oauth_error?: string;
}

/** Where a connector's OAuth sign-in returns. The API sends ids; this picks the page. */
export const signInReturnRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: CONNECTOR_SIGN_IN_RETURN_PATH,
	validateSearch: (search: Record<string, unknown>): SignInReturnSearch => ({
		workspace: optionalString(search.workspace),
		project: optionalString(search.project),
		oauth_error: optionalString(search.oauth_error),
	}),
	beforeLoad: requireSignedIn,
	component: SignInReturnRoute,
});

function SignInReturnRoute() {
	const { workspace, project: projectId, oauth_error: oauthError } = signInReturnRoute.useSearch();
	const { slug, owner, resolving } = useConnectorReturnDestination(workspace, projectId);
	const navigate = useNavigate();

	useEffect(() => {
		if (!owner || !slug) return;
		void navigate({
			...ownerConnectorsLink(slug, owner),
			search: { oauth_error: oauthError },
			replace: true,
		});
	}, [owner, slug, oauthError, navigate]);

	if ((owner && slug) || resolving) {
		return <Splash />;
	}
	return (
		<div className="grid h-full place-items-center bg-list p-6">
			<EmptyState title="Connector sign-in failed">
				<p>
					{oauthError
						? signInFailureReason(oauthError)
						: "The bot or project it was for is no longer available to you."}
				</p>
				<Link to="/" className="text-link underline">
					Return to workspace
				</Link>
			</EmptyState>
		</div>
	);
}

/**
 * Where a GitHub setup returns: the API names the project, its GitHub app
 * once GitHub made it, and why setup stopped when it did.
 */
export const gitHubSetupReturnRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: GITHUB_SETUP_RETURN_PATH,
	validateSearch: (search: Record<string, unknown>) => ({
		workspace: optionalString(search.workspace),
		project: optionalString(search.project),
		connector: optionalString(search.connector),
		github_error: optionalString(search.github_error),
	}),
	beforeLoad: requireSignedIn,
	component: GitHubSetupReturnRoute,
});

function GitHubSetupReturnRoute() {
	const {
		workspace,
		project: projectId,
		connector,
		github_error: failure,
	} = gitHubSetupReturnRoute.useSearch();
	const { slug, owner, resolving } = useConnectorReturnDestination(workspace, projectId);
	const navigate = useNavigate();

	useEffect(() => {
		if (failure || !slug || !owner || !connector) return;
		void navigate({ ...ownerConnectorLink(slug, owner, connector), replace: true });
	}, [failure, slug, owner, connector, navigate]);

	if ((!failure && slug && owner && connector) || resolving) {
		return <Splash />;
	}
	return (
		<div className="grid h-full place-items-center bg-list p-6">
			<EmptyState title="GitHub setup didn't finish">
				<p>{gitHubSetupFailureReason(failure)}</p>
				{slug && owner ? (
					<Link {...ownerConnectorsLink(slug, owner)} search={{}} className="text-link underline">
						Back to {ownerName(owner)}
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
 * Where a page outside any workspace returns to, from the ids the API sent
 * back: the workspace's slug, and whose connectors they are, by
 * `ownerOfProject` over the workspace's bots and projects. `resolving` while
 * either is still loading.
 */
function useConnectorReturnDestination(
	workspaceId: string | undefined,
	projectId: string | undefined,
): { slug: string | undefined; owner: ResourceOwner | undefined; resolving: boolean } {
	const workspaces = useWorkspaces();
	const slug = workspaces.data?.find((one) => one.id === workspaceId)?.slug;
	const enabled = projectId !== undefined;
	const bots = useQuery({ ...botsQuery(workspaceId), enabled });
	const projects = useQuery({ ...projectsQuery(workspaceId), enabled });
	const owner = enabled ? ownerOfProject(projectId, bots.data, projects.data) : undefined;
	const ownerResolving = !owner && enabled && (bots.isPending || projects.isPending);
	const resolving = workspaceId !== undefined && (ownerResolving || workspaces.isPending);
	return { slug, owner, resolving };
}

const GITHUB_SETUP_FAILURES: Record<GitHubSetupFailure, string> = {
	expired: "The link had expired, or was started by someone else. Start again from its connectors.",
	github: "GitHub refused or couldn't be reached. Try again in a moment.",
	cancelled: "It was cancelled on GitHub. Start again from its connectors when you're ready.",
};

function gitHubSetupFailureReason(failure: string | undefined) {
	return failure && failure in GITHUB_SETUP_FAILURES
		? GITHUB_SETUP_FAILURES[failure as GitHubSetupFailure]
		: "The bot or project it was for is no longer available to you.";
}

/*
 * An owner's Connectors page, and one connector on it, in the workspace
 * `workspaceSlug`. These return pages are outside any workspace, so they name
 * one; the link helpers in `links.ts` are for pages inside.
 */

function ownerConnectorsLink(workspaceSlug: string, owner: ResourceOwner) {
	return "bot" in owner
		? ({
				to: "/$workspace/bots/$bot/connectors",
				params: { workspace: workspaceSlug, bot: owner.bot.handle },
			} as const)
		: ({
				to: "/$workspace/projects/$project/connectors",
				params: { workspace: workspaceSlug, project: owner.project.slug },
			} as const);
}

function ownerConnectorLink(workspaceSlug: string, owner: ResourceOwner, connector: string) {
	return "bot" in owner
		? ({
				to: "/$workspace/bots/$bot/connectors/$connector",
				params: { workspace: workspaceSlug, bot: owner.bot.handle, connector },
			} as const)
		: ({
				to: "/$workspace/projects/$project/connectors/$connector",
				params: { workspace: workspaceSlug, project: owner.project.slug, connector },
			} as const);
}

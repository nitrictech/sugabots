import {
	CONNECTION_SIGN_IN_RETURN_PATH,
	GITHUB_SETUP_RETURN_PATH,
	type GitHubSetupFailure,
} from "@sugabots/contracts";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { botsQuery } from "@/lib/bots.ts";
import { signInFailureReason } from "@/lib/connections.ts";
import { projectsQuery } from "@/lib/projects.ts";
import type { ResourceOwner } from "@/lib/resource-owner.tsx";
import { useWorkspaces } from "@/lib/workspace.ts";
import { EmptyState } from "@/ui/empty-state.tsx";
import { requireUser, rootRoute } from "./root.tsx";
import { optionalString } from "./search.ts";

interface SignInReturnSearch {
	workspace?: string;
	/** The project the connection is of; with `bot`, that bot's default project. */
	project?: string;
	bot?: string;
	/** A code saying why the sign-in did not finish, shown only through `signInFailureReason`. */
	oauth_error?: string;
}

/** Where a connection's OAuth sign-in returns. The API sends ids; this picks the page. */
export const signInReturnRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: CONNECTION_SIGN_IN_RETURN_PATH,
	validateSearch: (search: Record<string, unknown>): SignInReturnSearch => ({
		workspace: optionalString(search.workspace),
		project: optionalString(search.project),
		bot: optionalString(search.bot),
		oauth_error: optionalString(search.oauth_error),
	}),
	beforeLoad: requireUser,
	component: SignInReturnRoute,
});

function SignInReturnRoute() {
	const {
		workspace,
		project: projectId,
		bot: botId,
		oauth_error: oauthError,
	} = signInReturnRoute.useSearch();
	const workspaces = useWorkspaces();
	const slug = workspaces.data?.find((one) => one.id === workspace)?.slug;
	const { owner, resolving: ownerResolving } = useOwnerOf(workspace, botId, projectId);
	const navigate = useNavigate();

	useEffect(() => {
		if (!owner || !slug) return;
		// Outside any workspace, so this names one; the link helpers are for pages inside.
		void navigate(
			"bot" in owner
				? {
						to: "/$workspace/settings/bots/$bot/$page",
						params: { workspace: slug, bot: owner.bot.handle, page: "connections" },
						search: { oauth_error: oauthError },
						replace: true,
					}
				: {
						to: "/$workspace/settings/projects/$project/$page",
						params: { workspace: slug, project: owner.project.slug, page: "connections" },
						search: { oauth_error: oauthError },
						replace: true,
					},
		);
	}, [owner, slug, oauthError, navigate]);

	const resolving = workspace !== undefined && (ownerResolving || workspaces.isPending);
	if ((owner && slug) || resolving) {
		return <div className="h-full bg-list" />;
	}
	return (
		<div className="grid h-full place-items-center bg-list p-6">
			<EmptyState title="Connection sign-in failed">
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
 * Where a GitHub setup returns: the API names the project, and the bot when it
 * is a bot's default project, its GitHub app once GitHub made it, and why
 * setup stopped when it did.
 */
export const gitHubSetupReturnRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: GITHUB_SETUP_RETURN_PATH,
	validateSearch: (search: Record<string, unknown>) => ({
		workspace: optionalString(search.workspace),
		project: optionalString(search.project),
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
		project: projectId,
		bot: botId,
		connection,
		github_error: failure,
	} = gitHubSetupReturnRoute.useSearch();
	const workspaces = useWorkspaces();
	const slug = workspaces.data?.find((one) => one.id === workspace)?.slug;
	const { owner, resolving: ownerResolving } = useOwnerOf(workspace, botId, projectId);
	const navigate = useNavigate();

	useEffect(() => {
		if (failure || !slug || !owner || !connection) return;
		// Outside any workspace, so this names one; the link helpers are for pages inside.
		void navigate(
			"bot" in owner
				? {
						to: "/$workspace/settings/bots/$bot/connections/$connection",
						params: { workspace: slug, bot: owner.bot.handle, connection },
						replace: true,
					}
				: {
						to: "/$workspace/settings/projects/$project/connections/$connection",
						params: { workspace: slug, project: owner.project.slug, connection },
						replace: true,
					},
		);
	}, [failure, slug, owner, connection, navigate]);

	const resolving = workspace !== undefined && (ownerResolving || workspaces.isPending);
	if ((!failure && slug && owner && connection) || resolving) {
		return <div className="h-full bg-list" />;
	}
	return (
		<div className="grid h-full place-items-center bg-list p-6">
			<EmptyState title="GitHub setup didn't finish">
				<p>{gitHubSetupFailureReason(failure)}</p>
				{slug && owner && "bot" in owner ? (
					<Link
						to="/$workspace/settings/bots/$bot"
						params={{ workspace: slug, bot: owner.bot.handle }}
						className="text-link underline"
					>
						Back to {owner.bot.name}
					</Link>
				) : slug && owner && "project" in owner ? (
					<Link
						to="/$workspace/settings/projects/$project/$page"
						params={{ workspace: slug, project: owner.project.slug, page: "connections" }}
						search={{}}
						className="text-link underline"
					>
						Back to {owner.project.name}
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
 * Whose connections a page outside any workspace returns to, from the ids
 * the API sent back: the bot `botId` of `workspace` when it names one, whose
 * default project the connection is of, else the project `projectId`.
 */
function useOwnerOf(
	workspace: string | undefined,
	botId: string | undefined,
	projectId: string | undefined,
): { owner: ResourceOwner | undefined; resolving: boolean } {
	const bots = useQuery({ ...botsQuery(workspace), enabled: botId !== undefined });
	const projects = useQuery({
		...projectsQuery(workspace),
		enabled: botId === undefined && projectId !== undefined,
	});
	if (botId !== undefined) {
		const bot = bots.data?.find((one) => one.id === botId);
		return { owner: bot && { bot }, resolving: bots.isPending };
	}
	const project = projects.data?.find((one) => one.id === projectId && one.isMember);
	return {
		owner: project && { project },
		resolving: projectId !== undefined && projects.isPending,
	};
}

const GITHUB_SETUP_FAILURES: Record<GitHubSetupFailure, string> = {
	expired:
		"The link had expired, or was started by someone else. Start again from its connections.",
	github: "GitHub refused or couldn't be reached. Try again in a moment.",
	cancelled: "It was cancelled on GitHub. Start again from its connections when you're ready.",
};

function gitHubSetupFailureReason(failure: string | undefined) {
	return failure && failure in GITHUB_SETUP_FAILURES
		? GITHUB_SETUP_FAILURES[failure as GitHubSetupFailure]
		: "The bot or project it was for is no longer available to you.";
}

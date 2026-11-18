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
import { useWorkspaces } from "@/lib/workspace.ts";
import { EmptyState } from "@/ui/empty-state.tsx";
import { requireUser, rootRoute } from "./root.tsx";
import { optionalString } from "./search.ts";

interface SignInReturnSearch {
	workspace?: string;
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
export const gitHubSetupReturnRoute = createRoute({
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

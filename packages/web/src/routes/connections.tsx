import { createRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { signInFailureReason } from "@/lib/connections.ts";
import { botRoute } from "./bots.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { useBotRouteOwner, useProjectRouteOwner } from "./owner.ts";
import { projectRoute } from "./projects.tsx";
import { validateSignInErrorSearch } from "./search.ts";

const ConnectionsPage = lazyNamed(() => import("@/screens/Connections.tsx"), "ConnectionsPage");

/*
 * A bot's connections and a project's, the same pages at each one's address:
 * listed as a page beside its threads, which one connection takes the place of.
 * A sign-in that did not finish comes back to the list with `?oauth_error=`.
 */

export const botConnectionsRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/connections",
	validateSearch: validateSignInErrorSearch,
	// A sign-in error shown for one bot must not follow you to the next.
	remountDeps: ({ params }) => [params.workspace, params.bot],
	loader: () => ConnectionsPage.preload(),
	component: () => {
		const signInError = useSignInErrorOnce(botConnectionsRoute);
		const owner = useBotRouteOwner();
		return owner ? <ConnectionsPage owner={owner} signInError={signInError} /> : null;
	},
});

export const botConnectionRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/connections/$connection",
	loader: () => ConnectionsPage.preload(),
	component: () => {
		const { connection } = botConnectionRoute.useParams();
		const owner = useBotRouteOwner();
		return owner ? <ConnectionsPage owner={owner} connectionId={connection} /> : null;
	},
});

export const projectConnectionsRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/connections",
	validateSearch: validateSignInErrorSearch,
	// A sign-in error shown for one project must not follow you to the next.
	remountDeps: ({ params }) => [params.workspace, params.project],
	loader: () => ConnectionsPage.preload(),
	component: () => {
		const signInError = useSignInErrorOnce(projectConnectionsRoute);
		const owner = useProjectRouteOwner();
		return owner ? <ConnectionsPage owner={owner} signInError={signInError} /> : null;
	},
});

export const projectConnectionRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/connections/$connection",
	loader: () => ConnectionsPage.preload(),
	component: () => {
		const { connection } = projectConnectionRoute.useParams();
		const owner = useProjectRouteOwner();
		return owner ? <ConnectionsPage owner={owner} connectionId={connection} /> : null;
	},
});

/**
 * Why the sign-in that returned to `route`'s page did not finish, in our own
 * words, as its `?oauth_error=` said: taken out of the address once read and
 * kept, so a reload does not show it twice.
 */
function useSignInErrorOnce(
	route: typeof botConnectionsRoute | typeof projectConnectionsRoute,
): string | undefined {
	const { oauth_error: oauthError } = route.useSearch();
	const navigate = route.useNavigate();
	const [signInError, setSignInError] = useState(oauthError);
	useEffect(() => {
		if (oauthError === undefined) return;
		setSignInError(oauthError);
		void navigate({
			search: (previous) => ({ ...previous, oauth_error: undefined }),
			replace: true,
		});
	}, [oauthError, navigate]);
	return signInError && signInFailureReason(signInError);
}

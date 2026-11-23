import { createRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { signInFailureReason } from "@/lib/connectors.ts";
import { botRoute } from "./bots.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { useBotRouteOwner, useProjectRouteOwner } from "./owner.ts";
import { projectRoute } from "./projects.tsx";
import { validateSignInErrorSearch } from "./search.ts";

const ConnectorsPage = lazyNamed(() => import("@/screens/Connectors.tsx"), "ConnectorsPage");

/*
 * A bot's connectors and a project's, the same pages at each one's address:
 * listed as a page beside its chats, which one connector takes the place of.
 * A sign-in that did not finish comes back to the list with `?oauth_error=`.
 */

export const botConnectorsRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/connectors",
	validateSearch: validateSignInErrorSearch,
	// A sign-in error shown for one bot must not follow you to the next.
	remountDeps: ({ params }) => [params.workspace, params.bot],
	loader: () => ConnectorsPage.preload(),
	component: () => {
		const signInError = useSignInErrorOnce(botConnectorsRoute);
		const owner = useBotRouteOwner();
		return owner ? <ConnectorsPage owner={owner} signInError={signInError} /> : null;
	},
});

export const botConnectorRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/connectors/$connector",
	loader: () => ConnectorsPage.preload(),
	component: () => {
		const { connector } = botConnectorRoute.useParams();
		const owner = useBotRouteOwner();
		return owner ? <ConnectorsPage owner={owner} connectorId={connector} /> : null;
	},
});

export const projectConnectorsRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/connectors",
	validateSearch: validateSignInErrorSearch,
	// A sign-in error shown for one project must not follow you to the next.
	remountDeps: ({ params }) => [params.workspace, params.project],
	loader: () => ConnectorsPage.preload(),
	component: () => {
		const signInError = useSignInErrorOnce(projectConnectorsRoute);
		const owner = useProjectRouteOwner();
		return owner ? <ConnectorsPage owner={owner} signInError={signInError} /> : null;
	},
});

export const projectConnectorRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/connectors/$connector",
	loader: () => ConnectorsPage.preload(),
	component: () => {
		const { connector } = projectConnectorRoute.useParams();
		const owner = useProjectRouteOwner();
		return owner ? <ConnectorsPage owner={owner} connectorId={connector} /> : null;
	},
});

/**
 * Why the sign-in that returned to `route`'s page did not finish, in our own
 * words, as its `?oauth_error=` said: taken out of the address once read and
 * kept, so a reload does not show it twice.
 */
function useSignInErrorOnce(
	route: typeof botConnectorsRoute | typeof projectConnectorsRoute,
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

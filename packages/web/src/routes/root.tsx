import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, type ParsedLocation, redirect } from "@tanstack/react-router";
import type { Session } from "@/lib/session.ts";
import { EmptyState } from "@/ui/empty-state.tsx";

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

export const rootRoute = createRootRouteWithContext<RouterContext>()({
	notFoundComponent: () => (
		<div className="grid h-full place-items-center bg-list">
			<EmptyState title="There is nothing at this address">
				The link may be old, or the workspace may have moved on.
			</EmptyState>
		</div>
	),
});

/**
 * Signed out means the login page. `undefined` cannot reach here: `main.tsx`
 * waits for `/me` to answer before it mounts the router at all.
 */
export function requireUser({
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

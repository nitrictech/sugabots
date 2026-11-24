import { isApiFailure } from "@sugabots/sdk";
import { QueryClient } from "@tanstack/react-query";

/**
 * The query cache.
 *
 * `SessionRouter` creates one for each current user, and a new one when
 * somebody else signs in, so nothing cached for one member is shown to the next.
 * Tests hand a fresh one to each case.
 *
 * Two defaults worth explaining:
 *
 * - **No retry on a failure the API meant.** A 404 or a 403 is an answer, not a
 *   network blip; retrying it three times only delays showing the member what
 *   happened. Anything else — a dropped connection, a 500 — is retried once.
 * - **`staleTime` of thirty seconds.** Lists like the sidebar's projects change
 *   rarely and are read on every navigation, which reuses a list fetched in the
 *   last thirty seconds rather than asking again.
 */
export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				retry: (attempt, failure) =>
					attempt < 1 && !(isApiFailure(failure) && failure._tag !== "InternalServerError"),
			},
			mutations: { retry: false },
		},
	});
}

/**
 * Set when a query could not load anything, to show a failure screen in its place.
 *
 * - A failed refresh of data already loaded is not a failure: the app keeps
 *   using that data, so a brief outage does not replace an open page.
 * - It stays set while the query tries again. React Query clears `error` during
 *   each retry, so `error` is empty until the retry fails or succeeds.
 */
export function loadFailure(query: {
	data: unknown;
	error: unknown;
	errorUpdateCount: number;
}): { error: unknown } | undefined {
	if (query.data !== undefined || query.errorUpdateCount === 0) return undefined;
	return { error: query.error };
}

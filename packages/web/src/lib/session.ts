import type { Me, SessionUser } from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { createContext, use, useCallback, useEffect, useRef, useState } from "react";
import { client } from "@/api.ts";

/**
 * Who you are, as far as the API is concerned.
 *
 * Only the API can read the HttpOnly session cookie and say whether it is still
 * good, so `/me` is what decides.
 *
 * `undefined` means the question is still open, which the router waits on
 * before it will resolve a guarded route.
 */

export interface Session {
	/** `undefined` before `/me` succeeds, `null` when signed out. */
	user: SessionUser | null | undefined;
	/** What `/me` answered beside `user`, for the session's query cache to start from. */
	me?: Me;
	/** Set once the API has stopped answering for long enough to be worth saying. */
	error: unknown;
	/** Re-ask the API. Called after signing in, out, or accepting an invitation. */
	refresh: () => Promise<void>;
}

/**
 * How long to keep asking before admitting the API is not there.
 *
 * A request that never reached the API is not an answer, and the commonest
 * reason for one is that the API is briefly not listening: it restarts on every
 * save in development, and a deploy does the same in production. Showing a dead
 * end that only a click or a reload clears makes a two second gap look like a
 * broken app. These retries cover a restart; past them something is actually
 * wrong and is worth saying so.
 */
const UNREACHABLE_RETRIES = 6;
const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 3_000, 3_000];

/** One of the API's failures is the API answering. Anything else never got there. */
const unreachable = (failure: unknown) => !isApiFailure(failure);

export function useSessionFromApi(): Session {
	// One answer, `null` when signed out, so `user` and `me` cannot disagree:
	// signing out leaves no earlier answer for a later session's cache to start from.
	const [me, setMe] = useState<Me | null>();
	const [error, setError] = useState<unknown>();
	const retry = useRef<ReturnType<typeof setTimeout>>(undefined);
	const live = useRef(true);

	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
			clearTimeout(retry.current);
		};
	}, []);

	const ask = useCallback(async (attempt: number): Promise<void> => {
		clearTimeout(retry.current);
		try {
			const answer = await Effect.runPromise(client.api.me());
			if (!live.current) return;
			setMe(answer);
			setError(undefined);
		} catch (failure) {
			if (!live.current) return;
			if (isApiFailure(failure) && failure._tag === "Unauthorized") {
				setMe(null);
				setError(undefined);
				return;
			}
			if (unreachable(failure) && attempt < UNREACHABLE_RETRIES) {
				// Still trying, so the session stays unresolved and the splash
				// stays up rather than flashing an error the next attempt clears.
				retry.current = setTimeout(
					() => void ask(attempt + 1).catch(() => {}),
					RETRY_DELAYS_MS[attempt] ?? 3_000,
				);
				return;
			}
			setError(failure);
			throw failure;
		}
	}, []);

	const refresh = useCallback(() => ask(0), [ask]);

	useEffect(() => {
		void refresh().catch(() => {});
	}, [refresh]);

	return { user: me === null ? null : me?.user, me: me ?? undefined, error, refresh };
}

/**
 * The session `useSessionFromApi` keeps, for the components below it. Route
 * guards read the same session from the router's context, but a route takes
 * that context only when it loads, so a component reading it there would not
 * see you change, as when you rename yourself, until the next navigation.
 */
export const SessionContext = createContext<Session | undefined>(undefined);

export function useSession(): Session {
	const session = use(SessionContext);
	if (!session) throw new Error("useSession needs a SessionContext above it");
	return session;
}

/**
 * Changes your name. Members, pods and chats look a person's name up whenever
 * they are read, so every cached answer is asked for again, as is who you are,
 * without holding up the save. Should `/me` fail just then, the old name stays
 * on screen until the session is next asked.
 */
export function useUpdateName() {
	const session = useSession();
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => client.auth.updateName({ name }),
		onSuccess: () => {
			void session.refresh().catch(() => {});
			void queries.invalidateQueries();
		},
	});
}

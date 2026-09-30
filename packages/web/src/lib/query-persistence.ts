import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { Query } from "@tanstack/react-query";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";
import { createStore, del, get, keys, set } from "idb-keyval";

/*
 * The query cache, kept in the browser between visits, so a reload draws the
 * chats as they were left and then catches up, rather than starting blank.
 *
 * Each signed-in person has their own entry, and every entry is deleted when
 * nobody is signed in: what was saved is their conversations, and it must not
 * outlast the session on a shared computer. A new build starts afresh, since
 * what it expects of the data may have changed.
 */

/** The first part of every query key saved, by what it holds: what the shell and a chat draw. */
const SAVED = new Set([
	"workspaces",
	"workspace-standing",
	"pods",
	"agents",
	"chat-list",
	"chat-pod-markers",
	"chat",
	"chat-messages",
	"thread",
	"thread-activity",
	"routines",
	"connections",
]);

/** A week: past that, a reload might as well start from the API. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const store = createStore("sugabots", "queries");

const entryFor = (userId: string) => `queries:${userId}`;

/**
 * How the signed-in person's cache is restored and saved, for
 * `PersistQueryClientProvider`, and an effect that saves only while it is
 * mounted. Saves are batched a moment behind the changes, so one can still be
 * due after sign-out has deleted the cache; once unmounted it writes nothing.
 */
export function savedQueriesFor(userId: string): {
	persistOptions: Omit<PersistQueryClientOptions, "queryClient">;
	saveWhileMounted: () => () => void;
} {
	let saving = false;
	return {
		persistOptions: {
			persister: createAsyncStoragePersister({
				key: entryFor(userId),
				storage: {
					getItem: (key) => get<string>(key, store).then((value) => value ?? null),
					setItem: (key, value: string) => (saving ? set(key, value, store) : Promise.resolve()),
					removeItem: (key) => del(key, store),
				},
			}),
			maxAge: MAX_AGE_MS,
			buster: __BUILD_ID__,
			dehydrateOptions: { shouldDehydrateQuery: isSaved },
		},
		saveWhileMounted: () => {
			saving = true;
			return () => {
				saving = false;
			};
		},
	};
}

/** Deletes every saved cache, whoever it belonged to: called once nobody is signed in. */
export async function forgetSavedQueries(): Promise<void> {
	const saved = await keys(store);
	await Promise.all(saved.map((key) => del(key, store)));
}

function isSaved(query: Query): boolean {
	const [kind] = query.queryKey;
	return query.state.status === "success" && typeof kind === "string" && SAVED.has(kind);
}

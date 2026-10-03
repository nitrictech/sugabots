import type {
	Connection,
	ConnectionAccess,
	ConnectionSignInFailure,
	ConnectionUpdate,
	ConnectionWithTools,
	NewConnection,
	UnsavedConnection,
} from "@sugabots/contracts";
import {
	connectionPresetFor,
	connectionSignInFailures,
	toolAccessCountsOf,
} from "@sugabots/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useMemo } from "react";
import { client } from "@/api.ts";

/** How many of the connection's tools its pod's bots can use: every one not set to off. */
export function usableToolCount(connection: Connection): number {
	return connection.toolCounts.allow + connection.toolCounts.ask;
}

/** The pod's connections, each with how many tools are at each setting but not the tools. */
export function useConnections(podId: string) {
	return useQuery({
		queryKey: ["connections", podId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.connections.list({ params: { podId } }), { signal }),
	});
}

/** One connection with its tools, without the server's descriptions of them. */
export function useConnectionWithTools(podId: string, connectionId: string) {
	return useQuery({
		queryKey: connectionKey(podId, connectionId),
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.connections.get({ params: { podId, connectionId } }), {
				signal,
			}),
	});
}

/** Under the pod's list, so refreshing the list refreshes every connection read from it too. */
const connectionKey = (podId: string, connectionId: string) => ["connections", podId, connectionId];

/** How a connection is named and marked wherever its tools are shown. */
export interface ConnectionLook {
	name: string;
	/** The catalog entry its logo comes from, when it came from one. */
	presetId?: string;
}

/**
 * The pod's connections by the handle that prefixes their tool keys, so a
 * `sentry__search_issues` in a transcript can be shown as Sentry's. A handle
 * missing from the map belongs to a connection that has since been removed;
 * callers write the handle out rather than dropping the step.
 */
export function useConnectionLooks(podId: string): ReadonlyMap<string, ConnectionLook> {
	const connections = useConnections(podId);
	const found = connections.data;
	return useMemo(() => {
		const looks = new Map<string, ConnectionLook>();
		for (const connection of found ?? []) {
			const preset = connectionPresetFor(connection.url);
			looks.set(connection.handle, {
				name: connection.name,
				presetId: preset?.id,
			});
		}
		return looks;
	}, [found]);
}

export function useConnectionActions(podId: string) {
	const queryClient = useQueryClient();
	const listKey = ["connections", podId];
	const updateKey = ["connections", podId, "update"];
	const refresh = () => queryClient.invalidateQueries({ queryKey: listKey });
	const { connections } = client.api;

	return {
		create: useMutation({
			mutationFn: (json: NewConnection) =>
				Effect.runPromise(connections.create({ params: { podId }, payload: json })),
			onSuccess: refresh,
		}),
		/**
		 * A change to what bots may do with the tools shows at once, and is put
		 * back if it fails. The list is fetched again once the last of several
		 * quick changes is done, so an earlier one's answer does not show the
		 * later ones undone.
		 */
		update: useMutation({
			mutationKey: updateKey,
			mutationFn: ({ connectionId, json }: { connectionId: string; json: ConnectionUpdate }) =>
				Effect.runPromise(connections.update({ params: { podId, connectionId }, payload: json })),
			onMutate: async ({ connectionId, json }) => {
				const chosen = choiceFor(json);
				if (!chosen) return undefined;
				await queryClient.cancelQueries({ queryKey: listKey });
				const detailKey = connectionKey(podId, connectionId);
				const before = {
					list: queryClient.getQueryData<Connection[]>(listKey),
					detail: queryClient.getQueryData<ConnectionWithTools>(detailKey),
				};
				const detail = before.detail && {
					...before.detail,
					tools: before.detail.tools.map((tool) => ({
						...tool,
						access: chosen(tool.name) ?? tool.access,
					})),
				};
				if (detail) queryClient.setQueryData(detailKey, detail);
				queryClient.setQueryData<Connection[]>(listKey, (listed) =>
					listed?.map((one) => {
						if (one.id !== connectionId) return one;
						if (detail) return { ...one, toolCounts: toolAccessCountsOf(detail.tools) };
						return json.access ? { ...one, toolCounts: allAt(one, json.access) } : one;
					}),
				);
				return { before, detailKey };
			},
			onError: (_failure, _change, context) => {
				if (!context) return;
				queryClient.setQueryData(listKey, context.before.list);
				queryClient.setQueryData(context.detailKey, context.before.detail);
			},
			onSettled: () => {
				// This mutation still counts until its own onSettled is done.
				if (queryClient.isMutating({ mutationKey: updateKey }) > 1) return;
				return refresh();
			},
		}),
		remove: useMutation({
			mutationFn: ({ connectionId }: { connectionId: string }) =>
				Effect.runPromise(connections.remove({ params: { podId, connectionId } })),
			onSuccess: refresh,
		}),
		testUnsaved: useMutation({
			mutationFn: (json: UnsavedConnection) =>
				Effect.runPromise(connections.testUnsaved({ params: { podId }, payload: json })),
		}),
		test: useMutation({
			mutationFn: ({ connectionId }: { connectionId: string }) =>
				Effect.runPromise(connections.test({ params: { podId, connectionId } })),
			onSettled: refresh,
		}),
		/**
		 * From the catalog: makes the connection and leaves for its sign-in, as one
		 * step. Its tools are learnt once the sign-in finishes, each starting at
		 * its default.
		 */
		connect: useMutation({
			mutationFn: async (json: { name: string; url: string }) => {
				const result = await Effect.runPromise(
					connections.connectFromCatalog({ params: { podId }, payload: json }),
				);
				browser.go(result.authorizationUrl);
				return result;
			},
		}),
		/**
		 * Starts signing a connection in. The browser leaves for the authorization
		 * server and comes back to this page through the API's callback, so
		 * nothing here needs to wait for it.
		 */
		signIn: useMutation({
			mutationFn: async ({ connectionId }: { connectionId: string }) => {
				const result = await Effect.runPromise(
					connections.startOAuth({ params: { podId, connectionId } }),
				);
				// Left here rather than in `onSuccess`, which is skipped once the
				// card that asked has gone from the page.
				if (result.authorizationUrl) browser.go(result.authorizationUrl);
				return result;
			},
			onSuccess: (result) => {
				if (!result.authorizationUrl) void refresh();
			},
		}),
	};
}

/**
 * What `change` sets each tool to, by its name, as the server will once it has
 * it, or nothing when it leaves the tools alone.
 */
function choiceFor(
	change: ConnectionUpdate,
): ((toolName: string) => ConnectionAccess | undefined) | undefined {
	const { access, toolAccess } = change;
	if (access) return () => access;
	if (toolAccess) return (toolName) => toolAccess[toolName];
	return undefined;
}

/** The connection's counts with every one of its tools at `access`. */
function allAt(connection: Connection, access: ConnectionAccess): Connection["toolCounts"] {
	const { allow, ask, off } = connection.toolCounts;
	return { allow: 0, ask: 0, off: 0, [access]: allow + ask + off };
}

/**
 * bearerAuthorization returns `token` as an `Authorization` header value:
 * `Bearer <token>`, trimmed, with no doubled `Bearer ` when `token` already has one.
 */
export function bearerAuthorization(token: string): string {
	return `Bearer ${token.trim().replace(/^bearer\s+/i, "")}`;
}

/** Leaving the page, behind one seam so a test can watch it. */
export const browser = { go: (url: string) => window.location.assign(url) };

/**
 * Why a connection's sign-in did not finish, in words for the person, from
 * the code the API put in the address. Anybody can write an address, so a
 * code the API does not send gets the general sentence instead of being shown.
 */
export function signInFailureReason(code: string): string {
	return isSignInFailure(code) ? SIGN_IN_FAILURE_REASONS[code] : "Something went wrong. Try again.";
}

const SIGN_IN_FAILURE_REASONS: Record<ConnectionSignInFailure, string> = {
	missing_state: "The sign-in came back incomplete. Try again.",
	unknown_state: "The sign-in does not match any connection.",
	not_allowed: "You are not allowed to connect a server in this pod.",
	refused: "The server's sign-in was refused or cancelled.",
	not_completed: "The server did not accept the sign-in. Try again.",
};

function isSignInFailure(code: string): code is ConnectionSignInFailure {
	return (connectionSignInFailures as readonly string[]).includes(code);
}

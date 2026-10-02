import type {
	Connection,
	ConnectionAccess,
	ConnectionSignInFailure,
	ConnectionToolWithAccess,
	ConnectionUpdate,
	NewConnection,
	UnsavedConnection,
} from "@sugabots/contracts";
import { connectionPresetFor, connectionSignInFailures } from "@sugabots/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useMemo } from "react";
import { client } from "@/api.ts";

/** The connection's tools its pod's bots can use: every one not set to off. */
export function usableTools(connection: Connection): ConnectionToolWithAccess[] {
	return connection.tools.filter((tool) => tool.access !== "off");
}

export function useConnections(podId: string) {
	return useQuery({
		queryKey: ["connections", podId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.connections.list({ params: { podId } }), { signal }),
	});
}

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
				const { toolAccess } = json;
				if (toolAccess === undefined) return undefined;
				await queryClient.cancelQueries({ queryKey: listKey });
				const before = queryClient.getQueryData<Connection[]>(listKey);
				queryClient.setQueryData<Connection[]>(listKey, (listed) =>
					listed?.map((one) => (one.id === connectionId ? withToolAccess(one, toolAccess) : one)),
				);
				return { before };
			},
			onError: (_failure, _change, context) => {
				if (context?.before) queryClient.setQueryData(listKey, context.before);
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

/** `connection` with each tool `toolAccess` names set as it says, as the server will once it has it. */
function withToolAccess(
	connection: Connection,
	toolAccess: Record<string, ConnectionAccess>,
): Connection {
	return {
		...connection,
		tools: connection.tools.map((tool) => ({
			...tool,
			access: toolAccess[tool.name] ?? tool.access,
		})),
	};
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

import type {
	ConnectionAccess,
	ConnectionProblem,
	ConnectionSignInFailure,
	ConnectionUpdate,
	NewConnection,
} from "@sugabots/contracts";
import { connectionPresetFor, connectionSignInFailures } from "@sugabots/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useMemo } from "react";
import { client } from "@/api.ts";

export function useConnections(podId: string) {
	return useQuery({
		queryKey: ["connections", podId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.connections.list({ params: { podId } }), { signal }),
	});
}

/**
 * useConnectionProbe reports whether the server at `url` offers an OAuth
 * sign-in. It asks nothing until `url` is an http(s) address, and a failed
 * request reports no sign-in.
 */
export function useConnectionProbe(podId: string, url: string) {
	const address = url.trim();
	const whole = /^https?:\/\/[^/\s]+/i.test(address);
	return useQuery({
		queryKey: ["connection-probe", podId, address],
		queryFn: ({ signal }) =>
			Effect.runPromise(
				client.api.connections.probe({ params: { podId }, payload: { url: address } }),
				{ signal },
			),
		enabled: whole,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
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
	const refresh = () => queryClient.invalidateQueries({ queryKey: ["connections", podId] });
	const { connections } = client.api;

	return {
		create: useMutation({
			mutationFn: (json: NewConnection) =>
				Effect.runPromise(
					// The generated client splits a union payload into one request type
					// per member, which a request holding the whole union does not satisfy.
					connections.create({ params: { podId }, payload: json } as Parameters<
						typeof connections.create
					>[0]),
				),
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: ({ connectionId, json }: { connectionId: string; json: ConnectionUpdate }) =>
				Effect.runPromise(connections.update({ params: { podId, connectionId }, payload: json })),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: ({ connectionId }: { connectionId: string }) =>
				Effect.runPromise(connections.remove({ params: { podId, connectionId } })),
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: ({ connectionId }: { connectionId: string }) =>
				Effect.runPromise(connections.test({ params: { podId, connectionId } })),
			onSettled: refresh,
		}),
		/**
		 * From the catalog: makes the connection and leaves for its sign-in, as one
		 * step. A new signed-in connection starts at Allow once its sign-in
		 * finishes, which only turns an Off one on, so Ask is set before leaving.
		 */
		connect: useMutation({
			mutationFn: async ({
				access,
				...json
			}: {
				name: string;
				url: string;
				access: Exclude<ConnectionAccess, "off">;
			}) => {
				const result = await Effect.runPromise(
					connections.connectFromCatalog({ params: { podId }, payload: json }),
				);
				if (access === "ask") {
					await Effect.runPromise(
						connections.update({
							params: { podId, connectionId: result.connectionId },
							payload: { access },
						}),
					);
				}
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

const TROUBLESHOOTING_PAGE = "https://sugabots.ai/docs/connections";

const TROUBLESHOOTING_SECTIONS: Record<ConnectionProblem, string> = {
	unauthorized: "token-or-sign-in-refused",
	forbidden: "access-refused",
	not_mcp_server: "not-an-mcp-server",
	server_error: "server-error",
	unreachable: "cant-reach-the-server",
	address_not_allowed: "address-not-allowed",
};

/** troubleshootingUrl returns the address of the docs section on fixing `problem`. */
export function troubleshootingUrl(problem: ConnectionProblem): string {
	return `${TROUBLESHOOTING_PAGE}#${TROUBLESHOOTING_SECTIONS[problem]}`;
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

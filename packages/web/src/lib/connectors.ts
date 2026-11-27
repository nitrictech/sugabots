import type {
	Bot,
	Connector,
	ConnectorAccess,
	ConnectorSignInFailure,
	ConnectorUpdate,
	ConnectorWithTools,
	NewConnector,
	ProjectBotConnector,
	UnsavedConnector,
} from "@sugabots/contracts";
import { connectorMarkFor, connectorSignInFailures, toolAccessCountsOf } from "@sugabots/contracts";
import {
	queryOptions,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/** How many of the connector's tools bots can use: every one not set to off. */
export function usableToolCount(connector: Connector): number {
	return connector.enabled === false ? 0 : connector.toolCounts.allow + connector.toolCounts.ask;
}

/** Whether someone must sign the connector in again, or fix it: it is not signed in, its sign-in expired, or it is failing. */
export function connectorNeedsAttention(connector: Connector): boolean {
	return !connector.signedIn || connector.signInExpired || connector.status === "error";
}

/**
 * A project's connectors, each with how many tools are at each setting. A
 * bot's are its default project's.
 */
export function useConnectors(projectId: string) {
	return useQuery(connectorsQuery(projectId));
}

export function useRestrictableConnectors(projectId: string) {
	return useQuery({
		...connectorListQuery(projectId),
		select: (rows) => rows.filter((row) => "restricted" in row),
	});
}

function connectorsQuery(projectId: string) {
	return queryOptions({
		...connectorListQuery(projectId),
		select: (rows) => rows.filter((row) => "url" in row),
	});
}

function connectorListQuery(projectId: string) {
	return queryOptions({
		queryKey: ["connectors", projectId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.connectors.list({ params: { projectId } }), { signal }),
	});
}

/**
 * The own connectors of a project's bots, each with whether it is on in the
 * project, where a bot uses one only while it is.
 */
export function useProjectBotConnectors(projectId: string) {
	return useQuery({
		queryKey: projectBotConnectorsKey(projectId),
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.connectors.listProjectBots({ params: { projectId } }), {
				signal,
			}),
	});
}

/** Turns a project bot's own connector on or off in the project. */
export function useSetProjectBotConnectorOn(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ connectorId, on }: { connectorId: string; on: boolean }) =>
			Effect.runPromise(
				client.api.connectors.setOnInProject({
					params: { projectId, connectorId },
					payload: { on },
				}),
			),
		onSuccess: (changed) =>
			queryClient.setQueryData<ProjectBotConnector[]>(projectBotConnectorsKey(projectId), (rows) =>
				rows?.map((row) => (row.id === changed.id ? changed : row)),
			),
	});
}

const projectBotConnectorsKey = (projectId: string) => ["projectBotConnectors", projectId];

/** One connector with its tools, without the server's descriptions of them. */
export function useConnectorWithTools(projectId: string, connectorId: string) {
	return useQuery({
		queryKey: connectorKey(projectId, connectorId),
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.connectors.get({ params: { projectId, connectorId } }), {
				signal,
			}),
	});
}

/** Under the project's list, so refreshing the list refreshes every connector read from it too. */
const connectorKey = (projectId: string, connectorId: string) => [
	"connectors",
	projectId,
	connectorId,
];

/** How a connector is named and marked wherever its tools are shown. */
export interface MarkedConnector {
	name: string;
	/** The built-in connector its logo comes from, when it is one. */
	markId?: string;
}

/**
 * The connectors a bot of `botIds` used in a chat of the project
 * `projectId`, by the handle that prefixes their tool keys, so its
 * `sentry__search_issues` can be shown as Sentry's: given a bot, the
 * project's connectors and the bot's own, its default project's. Where both
 * have a handle the project's is the one, as the server uses it; another
 * bot's own connectors never name this one's calls. A handle missing from
 * the map belongs to a connector that has since been removed; callers write
 * the handle out rather than dropping the step.
 */
export function useMarkedConnectors(
	botIds: readonly string[],
	projectId?: string | null,
): (botId: string) => ReadonlyMap<string, MarkedConnector> {
	const defaultProjectOf = useDefaultProjectsOf(botIds);
	const projectIds = [
		...new Set([...(projectId ? [projectId] : []), ...defaultProjectOf.values()]),
	];
	const lists = useQueries({
		queries: projectIds.map((one) => connectorsQuery(one)),
	});
	const markedIn = new Map(
		projectIds.map((one, index) => [one, markedConnectorsByHandle(lists[index]?.data ?? [])]),
	);
	const projectMarked = projectId ? markedIn.get(projectId) : undefined;
	return (botId) => {
		const defaultProjectId = defaultProjectOf.get(botId);
		const ownMarked = defaultProjectId ? markedIn.get(defaultProjectId) : undefined;
		// The project's entries come last, so they win a handle both have.
		return new Map([...(ownMarked ?? []), ...(projectMarked ?? [])]);
	};
}

function markedConnectorsByHandle(connectors: readonly Connector[]): Map<string, MarkedConnector> {
	return new Map(
		connectors.map((connector) => [
			connector.handle,
			{ name: connector.name, markId: connectorMarkFor(connector) },
		]),
	);
}

/**
 * The default projects of the bots `botIds`, by bot, as the bot rosters
 * already loaded say: a transcript is shown inside a workspace whose roster
 * the sidebar has loaded. A bot no roster has yet is left out.
 */
function useDefaultProjectsOf(botIds: readonly string[]): ReadonlyMap<string, string> {
	const rosters = useQueryClient().getQueriesData<readonly Bot[]>({ queryKey: ["bots"] });
	return new Map(
		botIds.flatMap((botId): [string, string][] => {
			for (const [, roster] of rosters) {
				const found = roster?.find((one) => one.id === botId);
				if (found) return [[botId, found.defaultProjectId]];
			}
			return [];
		}),
	);
}

export function useConnectorActions(projectId: string) {
	const queryClient = useQueryClient();
	const listKey = ["connectors", projectId];
	const updateKey = ["connectors", projectId, "update"];
	const refresh = () => queryClient.invalidateQueries({ queryKey: listKey });
	const { connectors } = client.api;

	return {
		create: useMutation({
			mutationFn: (json: NewConnector) =>
				Effect.runPromise(
					connectors.create({ params: { projectId }, payload: { connector: json } }),
				),
			onSuccess: refresh,
		}),
		/**
		 * A change to what bots may do with the tools shows at once. Changes are
		 * sent one at a time, in the order made, so the last one made is the one
		 * kept. The list is fetched again once the last of several quick changes
		 * is done, so an earlier one's answer does not show the later ones
		 * undone; that also takes back any that failed. While none are left, a
		 * failed one is put back at once.
		 */
		update: useMutation({
			mutationKey: updateKey,
			scope: { id: `connector-update:${projectId}` },
			mutationFn: ({ connectorId, json }: { connectorId: string; json: ConnectorUpdate }) =>
				Effect.runPromise(
					connectors.update({ params: { projectId, connectorId }, payload: { changes: json } }),
				),
			onMutate: async ({ connectorId, json }) => {
				const chosen = choiceFor(json);
				if (!chosen) return undefined;
				await queryClient.cancelQueries({ queryKey: listKey });
				const detailKey = connectorKey(projectId, connectorId);
				const before = {
					list: queryClient.getQueryData<Connector[]>(listKey),
					detail: queryClient.getQueryData<ConnectorWithTools>(detailKey),
				};
				const detail = before.detail && {
					...before.detail,
					tools: before.detail.tools.map((tool) => ({
						...tool,
						access: chosen(tool.name) ?? tool.access,
					})),
				};
				if (detail) queryClient.setQueryData(detailKey, detail);
				queryClient.setQueryData<Connector[]>(listKey, (listed) =>
					listed?.map((one) => {
						if (one.id !== connectorId) return one;
						if (detail) return { ...one, toolCounts: toolAccessCountsOf(detail.tools) };
						return json.access ? { ...one, toolCounts: allAt(one, json.access) } : one;
					}),
				);
				return { before, detailKey };
			},
			onError: (_failure, _change, context) => {
				// Changes still on their way are shown over it; the refetch after the last sorts it out.
				if (!context || queryClient.isMutating({ mutationKey: updateKey }) > 1) return;
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
			mutationFn: ({ connectorId }: { connectorId: string }) =>
				Effect.runPromise(connectors.remove({ params: { projectId, connectorId } })),
			onSuccess: refresh,
		}),
		testUnsaved: useMutation({
			mutationFn: (json: UnsavedConnector) =>
				Effect.runPromise(connectors.testUnsaved({ params: { projectId }, payload: json })),
		}),
		test: useMutation({
			mutationFn: ({ connectorId }: { connectorId: string }) =>
				Effect.runPromise(connectors.test({ params: { projectId, connectorId } })),
			onSettled: refresh,
		}),
		/**
		 * A built-in connector: makes the connector and leaves for its sign-in, as one
		 * step. Its tools are learnt once the sign-in finishes, each starting at
		 * its default.
		 */
		connect: useMutation({
			mutationFn: async (json: { name: string; url: string }) => {
				const result = await Effect.runPromise(
					connectors.connectBuiltIn({ params: { projectId }, payload: json }),
				);
				browser.go(result.authorizationUrl);
				return result;
			},
		}),
		/**
		 * Starts signing a connector in. The browser leaves for the authorization
		 * server and comes back to this page through the API's callback, so
		 * nothing here needs to wait for it.
		 */
		signIn: useMutation({
			mutationFn: async ({ connectorId }: { connectorId: string }) => {
				const result = await Effect.runPromise(
					connectors.startOAuth({ params: { projectId, connectorId } }),
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
	change: ConnectorUpdate,
): ((toolName: string) => ConnectorAccess | undefined) | undefined {
	const { access, toolAccess } = change;
	if (access) return () => access;
	if (toolAccess) return (toolName) => toolAccess[toolName];
	return undefined;
}

/** The connector's counts with every one of its tools at `access`. */
function allAt(connector: Connector, access: ConnectorAccess): Connector["toolCounts"] {
	const { allow, ask, off } = connector.toolCounts;
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
 * Why a connector's sign-in did not finish, in words for the member, from
 * the code the API put in the address. Anybody can write an address, so a
 * code the API does not send gets the general sentence instead of being shown.
 */
export function signInFailureReason(code: string): string {
	return isSignInFailure(code) ? SIGN_IN_FAILURE_REASONS[code] : "Something went wrong. Try again.";
}

const SIGN_IN_FAILURE_REASONS: Record<ConnectorSignInFailure, string> = {
	unknown_state: "The sign-in could not be found. Try again.",
	refused: "The server's sign-in was refused or cancelled.",
	not_completed: "The server did not accept the sign-in. Try again.",
};

function isSignInFailure(code: string): code is ConnectorSignInFailure {
	return (connectorSignInFailures as readonly string[]).includes(code);
}

export * as SearchProviderSetup from "./search-provider-setup.ts";

import type {
	NewSearchProvider,
	SearchProvider,
	SearchProviderTestResult,
	SearchProviderUpdate,
} from "@sugabots/contracts";
import { searchProviderPreset } from "@sugabots/contracts";
import { Clock, Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { serviceOperations } from "../../database/database.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { Egress } from "../network/egress.ts";
import { requireAllowedUrl, type UrlNotAllowed } from "../tested-configuration.ts";
import { searchBackend, searchEndpoint } from "./backends.ts";
import { searchProviderOf, toSearchProvider } from "./search-provider-reads.ts";
import { SearchProviderRepository } from "./search-provider-repository.ts";

/**
 * Choosing where a workspace's `web_search` goes: checking an address against
 * the egress policy before it is stored, and trying the service with a query.
 * The workspace is named by its id or its slug. Configuring the provider takes
 * the current actor's `workspace.providers.manage`; asking whether the web
 * tools are on takes only `workspace.read`.
 */
export interface Interface {
	/** The workspace's provider, or nothing when it has none. */
	readonly get: (
		workspace: string,
	) => Effect.Effect<SearchProvider | undefined, AuthorizationDenied, CurrentActor.Service>;
	/** Whether the workspace's bots are offered the web tools. */
	readonly webAccess: (
		workspace: string,
	) => Effect.Effect<boolean, AuthorizationDenied, CurrentActor.Service>;
	readonly replace: (input: {
		workspace: string;
		provider: NewSearchProvider;
	}) => Effect.Effect<
		SearchProvider,
		AuthorizationDenied | UrlNotAllowed | SearchProviderRepository.SearchProviderApiKeyRequired,
		CurrentActor.Service
	>;
	readonly update: (input: {
		workspace: string;
		changes: SearchProviderUpdate;
	}) => Effect.Effect<
		SearchProvider,
		| AuthorizationDenied
		| SearchProviderNotFound
		| UrlNotAllowed
		| SearchProviderRepository.SearchProviderApiKeyRequired,
		CurrentActor.Service
	>;
	readonly remove: (
		workspace: string,
	) => Effect.Effect<void, AuthorizationDenied | SearchProviderNotFound, CurrentActor.Service>;
	/** Sends a query, and records what came back against the configuration that sent it. */
	readonly test: (
		workspace: string,
	) => Effect.Effect<
		SearchProviderTestResult,
		AuthorizationDenied | SearchProviderNotFound,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SearchProviderSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("SearchProviderSetup");
	const authorization = yield* Authorization.Service;
	const providers = yield* SearchProviderRepository.Service;
	const egress = yield* Egress.Service;

	/** The id of the workspace `workspace` names, once the actor may configure its providers. */
	const managed = (workspace: string) =>
		Effect.map(
			authorization.workspace(workspace, "workspace.providers.manage"),
			({ workspaceId }) => workspaceId,
		);

	const requireProvider = (workspaceId: string) =>
		Effect.filterOrFail(
			searchProviderOf(workspaceId),
			(provider) => provider !== undefined,
			() => new SearchProviderNotFound(),
		);

	return Service.of({
		get: (workspace) => operation("get", Effect.flatMap(managed(workspace), searchProviderOf)),

		webAccess: (workspace) =>
			operation(
				"webAccess",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					return (yield* providers.resolve(workspaceId)) !== undefined;
				}),
			),

		replace: ({ workspace, provider }) =>
			operation(
				"replace",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						workspace,
						"workspace.providers.manage",
					);
					yield* requireAllowedUrl(
						egress,
						provider.baseUrl ?? searchProviderPreset(provider.preset).baseUrl,
					);
					return toSearchProvider(
						yield* providers.replace(workspaceId, { createdById: actor.userId, provider }),
					);
				}),
			),

		update: ({ workspace, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					if (changes.baseUrl) {
						yield* requireAllowedUrl(egress, changes.baseUrl);
					}
					const updated = yield* providers.update(workspaceId, changes);
					if (!updated) {
						return yield* new SearchProviderNotFound();
					}
					return toSearchProvider(updated);
				}),
			),

		remove: (workspace) =>
			operation(
				"remove",
				Effect.gen(function* () {
					if (!(yield* providers.remove(yield* managed(workspace)))) {
						return yield* new SearchProviderNotFound();
					}
				}),
			),

		test: (workspace) =>
			operation(
				"test",
				Effect.gen(function* () {
					const workspaceId = yield* managed(workspace);
					yield* requireProvider(workspaceId);
					const connection = yield* providers.connection(workspaceId);
					if (!connection) {
						return {
							reachable: false,
							latencyMs: 0,
							error: UserMessage.of`Add an API key before testing`,
						};
					}
					const started = yield* Clock.currentTimeMillis;
					const outcome = yield* searchBackend(
						connection,
						egress.providers.for({ baseUrl: searchEndpoint(connection) }),
					)({ query: TEST_QUERY, count: 3 });
					const latencyMs = (yield* Clock.currentTimeMillis) - started;
					const error = outcome.ok ? undefined : outcome.reason;
					yield* providers.recordTest(workspaceId, connection.configurationUpdatedAt, error);
					return {
						reachable: outcome.ok,
						latencyMs,
						...(outcome.ok ? { results: outcome.results.length } : { error }),
					};
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, SearchProviderRepository.layer]),
);

export class SearchProviderNotFound
	extends Data.TaggedError("SearchProviderNotFound")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This workspace has no search provider`;
	}
}

const TEST_QUERY = "Sugabots agents";

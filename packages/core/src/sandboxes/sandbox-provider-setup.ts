export * as SandboxProviderSetup from "./sandbox-provider-setup.ts";

import type {
	NewSandboxProvider,
	SandboxProvider,
	SandboxProviderTestResult,
	SandboxProviderUpdate,
} from "@sugabots/contracts";
import { SANDBOX_IMAGE } from "@sugabots/contracts";
import { Clock, Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { serviceOperations } from "../database/database.ts";
import { Egress } from "../providers/network/egress.ts";
import { requireAllowedUrl, type UrlNotAllowed } from "../providers/tested-configuration.ts";
import { type UserFacing, UserMessage } from "../user-message.ts";
import { pinnedToDigest } from "./image-digest.ts";
import { PodSandboxes } from "./pod-sandboxes.ts";
import { toSandboxProvider } from "./sandbox-provider-reads.ts";
import { SandboxProviderRepository } from "./sandbox-provider-repository.ts";
import { Sandboxes } from "./sandboxes.ts";

/**
 * Configuring where a workspace's sandboxes run: checking addresses against
 * the egress policy before they are stored, trying a provider's account, and
 * removing a provider only once its sandboxes are destroyed. Every method
 * takes the current actor's `workspace.providers.manage` on the workspace,
 * named by its id or its slug.
 */
export interface Interface {
	readonly list: (
		workspace: string,
	) => Effect.Effect<readonly SandboxProvider[], AuthorizationDenied, CurrentActor.Service>;
	/**
	 * Whether the workspace's agents can be given a sandbox. Takes only
	 * `workspace.read`, so an agent's settings can say why its switch is off.
	 */
	readonly access: (
		workspace: string,
	) => Effect.Effect<boolean, AuthorizationDenied, CurrentActor.Service>;
	readonly create: (input: {
		workspace: string;
		provider: NewSandboxProvider;
	}) => Effect.Effect<
		SandboxProvider,
		AuthorizationDenied | UrlNotAllowed | SandboxProviderRepository.SandboxProviderIncomplete,
		CurrentActor.Service
	>;
	readonly update: (input: {
		workspace: string;
		providerId: string;
		changes: SandboxProviderUpdate;
	}) => Effect.Effect<
		SandboxProvider,
		| AuthorizationDenied
		| SandboxProviderNotFound
		| UrlNotAllowed
		| SandboxProviderRepository.SandboxProviderIncomplete,
		CurrentActor.Service
	>;
	/** Destroys the provider's sandboxes, then removes it. */
	readonly remove: (input: {
		workspace: string;
		providerId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | SandboxProviderNotFound | SandboxesNotDestroyed,
		CurrentActor.Service
	>;
	/**
	 * How the provider's template stands, for a provider that builds its
	 * sandboxes' template (E2B); `undefined` for one that takes images as they are.
	 */
	readonly templateStatus: (input: {
		workspace: string;
		providerId: string;
	}) => Effect.Effect<
		Sandboxes.TemplateStatus | undefined,
		AuthorizationDenied | SandboxProviderNotFound | Sandboxes.Unavailable,
		CurrentActor.Service
	>;
	/** Starts building the provider's template from Sugabots' sandbox image, in the workspace's own account. */
	readonly prepareTemplate: (input: {
		workspace: string;
		providerId: string;
	}) => Effect.Effect<
		Sandboxes.TemplateStatus,
		AuthorizationDenied | SandboxProviderNotFound | NoTemplates | Sandboxes.Unavailable,
		CurrentActor.Service
	>;
	/** Asks the provider whether it answers and accepts the key, and records how that went. */
	readonly test: (input: {
		workspace: string;
		providerId: string;
	}) => Effect.Effect<
		SandboxProviderTestResult,
		AuthorizationDenied | SandboxProviderNotFound,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SandboxProviderSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("SandboxProviderSetup");
	const authorization = yield* Authorization.Service;
	const providers = yield* SandboxProviderRepository.Service;
	const podSandboxes = yield* PodSandboxes.Service;
	const sandboxes = yield* Sandboxes.Service;
	const egress = yield* Egress.Service;

	const managed = (workspace: string) =>
		authorization.workspace(workspace, "workspace.providers.manage");

	const requireAllowedUrls = (urls: ReadonlyArray<string | null | undefined>) =>
		Effect.forEach(urls, (url) => (url ? requireAllowedUrl(egress, url) : Effect.void), {
			discard: true,
		});

	const requireProvider = (workspaceId: string, providerId: string) =>
		Effect.flatMap(providers.list(workspaceId), (rows) => {
			const row = rows.find((candidate) => candidate.id === providerId);
			return row ? Effect.succeed(row) : Effect.fail(new SandboxProviderNotFound());
		});

	return Service.of({
		list: (workspace) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspace);
					return (yield* providers.list(workspaceId)).map(toSandboxProvider);
				}),
			),

		access: (workspace) =>
			operation(
				"access",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					return (yield* providers.enabled(workspaceId)) !== undefined;
				}),
			),

		create: ({ workspace, provider }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* managed(workspace);
					yield* requireAllowedUrls([provider.baseUrl, provider.sandboxUrl]);
					return toSandboxProvider(
						yield* providers.create(workspaceId, { createdById: actor.userId, provider }),
					);
				}),
			),

		update: ({ workspace, providerId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspace);
					yield* requireAllowedUrls([changes.baseUrl, changes.sandboxUrl]);
					const updated = yield* providers.update(workspaceId, providerId, changes);
					if (!updated) return yield* new SandboxProviderNotFound();
					return toSandboxProvider(updated);
				}),
			),

		remove: ({ workspace, providerId }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspace);
					yield* requireProvider(workspaceId, providerId);
					if (yield* podSandboxes.anyMadeBy(workspaceId, providerId)) {
						const configured = yield* providers.connection(workspaceId, providerId);
						if (!configured) return yield* new SandboxesNotDestroyed({ cause: "incomplete" });
						yield* podSandboxes
							.destroyAllMadeBy(workspaceId, configured)
							.pipe(Effect.mapError((cause) => new SandboxesNotDestroyed({ cause })));
					}
					if (!(yield* providers.remove(workspaceId, providerId))) {
						return yield* new SandboxProviderNotFound();
					}
				}),
			),

		templateStatus: ({ workspace, providerId }) =>
			operation(
				"templateStatus",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspace);
					const row = yield* requireProvider(workspaceId, providerId);
					const configured = yield* providers.connection(workspaceId, providerId);
					const templates = configured && sandboxes.forConnection(configured.connection).templates;
					if (!templates) return undefined;
					return yield* templates.status(row.templateBuild ?? undefined);
				}),
			),

		prepareTemplate: ({ workspace, providerId }) =>
			operation(
				"prepareTemplate",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspace);
					yield* requireProvider(workspaceId, providerId);
					const configured = yield* providers.connection(workspaceId, providerId);
					const templates = configured && sandboxes.forConnection(configured.connection).templates;
					if (!templates) return yield* new NoTemplates();
					const image = yield* Effect.promise(() =>
						pinnedToDigest(SANDBOX_IMAGE, egress.providers).catch(() => SANDBOX_IMAGE),
					);
					const build = yield* templates.build(image);
					yield* providers.recordTemplateBuild(workspaceId, providerId, build);
					return yield* templates.status(build);
				}),
			),

		test: ({ workspace, providerId }) =>
			operation(
				"test",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspace);
					yield* requireProvider(workspaceId, providerId);
					const configured = yield* providers.connection(workspaceId, providerId);
					if (!configured) {
						return {
							reachable: false,
							latencyMs: 0,
							error: UserMessage.of`Add the provider's settings before testing`,
						};
					}
					const started = yield* Clock.currentTimeMillis;
					const failure = yield* sandboxes.forConnection(configured.connection).check.pipe(
						Effect.as(undefined),
						Effect.catchTag("SandboxUnavailable", () =>
							Effect.succeed(
								UserMessage.of`The provider didn't answer, or refused the key. Check its address and key.`,
							),
						),
					);
					const latencyMs = (yield* Clock.currentTimeMillis) - started;
					yield* providers.recordTest(
						workspaceId,
						providerId,
						configured.configurationUpdatedAt,
						failure,
					);
					return {
						reachable: failure === undefined,
						latencyMs,
						...(failure ? { error: failure } : {}),
					};
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Authorization.layer,
		SandboxProviderRepository.layer,
		PodSandboxes.layer,
		Sandboxes.layer,
	]),
);

/** The provider takes images as they are, or lacks the settings to build a template with. */
export class NoTemplates extends Data.TaggedError("NoTemplates") implements UserFacing {
	get userMessage() {
		return UserMessage.of`This provider has no template to prepare. Add its key first, if it needs one.`;
	}
}

export class SandboxProviderNotFound
	extends Data.TaggedError("SandboxProviderNotFound")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This workspace has no such sandbox provider`;
	}
}

/**
 * The provider's sandboxes couldn't be destroyed, so it was kept: removing it
 * would leave them running at the provider with nothing to remove them.
 */
export class SandboxesNotDestroyed
	extends Data.TaggedError("SandboxesNotDestroyed")<{
		cause: Sandboxes.Unavailable | "incomplete";
	}>
	implements UserFacing
{
	get userMessage() {
		return this.cause === "incomplete"
			? UserMessage.of`This provider still has sandboxes, and needs its settings to remove them. Restore its key or address, then remove it.`
			: UserMessage.of`This provider's sandboxes couldn't be removed because it didn't answer. Try again when it's reachable.`;
	}
}

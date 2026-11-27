export * as ComputerProviderSetup from "./computer-provider-setup.ts";

import type {
	ComputerAccess,
	ComputerProvider,
	ComputerProviderSettings,
	ComputerProviderUpdate,
	ComputerTemplate,
	NewComputerProvider,
	ProviderTestResult,
} from "@sugabots/contracts";
import { COMPUTER_IMAGE } from "@sugabots/contracts";
import {
	type ComputerMadeMeanwhile,
	type ComputerProviderBuiltInFixed,
	type ComputerProviderHasComputers,
	type ComputerProviderIncomplete,
	ComputerProviderNotFound,
	ComputersNotDestroyed,
	type ComputerUnavailable,
	NoTemplates,
} from "@sugabots/contracts/errors/computers";
import type { UrlNotAllowed } from "@sugabots/contracts/errors/providers";
import { userText } from "@sugabots/errors";
import { Context, Effect, Layer } from "effect";
import { serviceOperations, transaction } from "../database/database.ts";
import type { Named } from "../proofs/proof.ts";
import type { ReachesComputerProvider } from "../proofs/reaches-computer-provider.ts";
import type { CanManageWorkspace, CanReadWorkspace } from "../proofs/workspace-permissions.ts";
import { Egress } from "../providers/network/egress.ts";
import { requireAllowedUrl, timedTest } from "../providers/tested-configuration.ts";
import { processLayer, Tier } from "../tiers.ts";
import { toComputerProvider } from "./computer-provider-reads.ts";
import { ComputerProviderStore } from "./computer-provider-store.ts";
import { Computers } from "./computers.ts";
import { pinnedToDigest } from "./image-digest.ts";
import { ProjectComputers } from "./project-computers.ts";

/**
 * Configuring where a workspace's computers run, for operations that have
 * proved the member may manage the workspace: checking addresses against the
 * egress policy before they are stored, trying a provider's account, and
 * removing a provider only once its computers are destroyed. Each method takes
 * the workspace from its proof, and a provider of another workspace is not
 * found.
 */
export interface Interface {
	readonly list: <P, W>(
		canManage: CanManageWorkspace<P, W>,
	) => Effect.Effect<readonly ComputerProvider[]>;
	/**
	 * Whether the workspace's projects can be given a computer. Anyone who may
	 * read the workspace may ask, so a bot's settings can say why its switch is off.
	 */
	readonly access: <P, W>(canRead: CanReadWorkspace<P, W>) => Effect.Effect<ComputerAccess>;
	readonly create: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		provider: NewComputerProvider,
	) => Effect.Effect<ComputerProvider, UrlNotAllowed | ComputerProviderIncomplete>;
	readonly update: <P, W, V>(
		canManage: CanManageWorkspace<P, W>,
		provider: Named<V, string>,
		target: ReachesComputerProvider<P, W, V>,
		changes: ComputerProviderUpdate,
	) => Effect.Effect<
		ComputerProvider,
		| ComputerProviderNotFound
		| UrlNotAllowed
		| ComputerProviderIncomplete
		| ComputerProviderBuiltInFixed
		| ComputerProviderHasComputers
	>;
	/**
	 * Destroys the provider's computers, then removes it. When one is made
	 * meanwhile the provider is kept, to try again.
	 */
	readonly remove: <P, W, V>(
		canManage: CanManageWorkspace<P, W>,
		provider: Named<V, string>,
		target: ReachesComputerProvider<P, W, V>,
	) => Effect.Effect<
		void,
		ComputerProviderNotFound | ComputersNotDestroyed | ComputerMadeMeanwhile
	>;
	/**
	 * How the provider's template stands, for a provider that builds its
	 * computers' template (E2B); null for one that takes images as they are.
	 */
	readonly template: <P, W, V>(
		canManage: CanManageWorkspace<P, W>,
		provider: Named<V, string>,
		target: ReachesComputerProvider<P, W, V>,
	) => Effect.Effect<ComputerTemplate, ComputerProviderNotFound | ComputerUnavailable>;
	/** Starts building the provider's template from Sugabots' computer image, in the workspace's own account. */
	readonly prepareTemplate: <P, W, V>(
		canManage: CanManageWorkspace<P, W>,
		provider: Named<V, string>,
		target: ReachesComputerProvider<P, W, V>,
	) => Effect.Effect<
		ComputerTemplate,
		ComputerProviderNotFound | NoTemplates | ComputerUnavailable
	>;
	/** Asks the provider whether it answers and accepts the key, and records how that went. */
	readonly test: <P, W, V>(
		canManage: CanManageWorkspace<P, W>,
		provider: Named<V, string>,
		target: ReachesComputerProvider<P, W, V>,
	) => Effect.Effect<ProviderTestResult, ComputerProviderNotFound>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ComputerProviderSetup",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ComputerProviderSetup");
	const providers = yield* ComputerProviderStore.Service;
	const projectComputers = yield* ProjectComputers.Service;
	const computers = yield* Computers.Service;
	const egress = yield* Egress.Service;

	const requireAllowedUrls = (settings: ComputerProviderSettings | undefined) =>
		Effect.forEach(
			settings ? ComputerProviderStore.addressesIn(settings) : [],
			(url) => requireAllowedUrl(egress, url),
			{ discard: true },
		);

	const requireProvider = (workspaceId: string, providerId: string) =>
		Effect.flatMap(providers.list(workspaceId), (rows) => {
			const row = rows.find((candidate) => candidate.id === providerId);
			return row ? Effect.succeed(row) : Effect.fail(new ComputerProviderNotFound());
		});

	/** The workspace a proof about it names. */
	const workspaceOf = <P, W>(proof: CanManageWorkspace<P, W> | CanReadWorkspace<P, W>) =>
		proof.inWorkspace.workspace.value;

	return Service.of({
		list: (canManage) =>
			operation(
				"list",
				Effect.map(providers.list(workspaceOf(canManage)), (rows) => rows.map(toComputerProvider)),
			),

		access: (canRead) =>
			operation(
				"access",
				Effect.map(providers.enabled(workspaceOf(canRead)), (enabled) => ({
					enabled: enabled !== undefined,
				})),
			),

		create: (canManage, provider) =>
			operation(
				"create",
				Effect.gen(function* () {
					// Checked as it will be stored, with the usual address filled in.
					yield* requireAllowedUrls(ComputerProviderStore.withUsualAddress(provider.settings));
					return toComputerProvider(
						yield* providers.create(workspaceOf(canManage), {
							createdById: canManage.actor.memberId,
							provider,
						}),
					);
				}),
			),

		update: (_canManage, provider, target, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					const workspaceId = target.workspace.value;
					const providerId = provider.value;
					yield* requireAllowedUrls(changes.settings);
					const before = yield* requireProvider(workspaceId, providerId);
					const updated = yield* providers.update(workspaceId, providerId, changes);
					if (!updated) return yield* new ComputerProviderNotFound();
					const modeOf = (row: typeof before) => ComputerProviderStore.networkModeIn(row.settings);
					if (modeOf(updated) !== modeOf(before)) {
						yield* projectComputers.applyNetwork({ workspaceId });
					}
					return toComputerProvider(updated);
				}),
			),

		remove: (_canManage, provider, target) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const workspaceId = target.workspace.value;
					const providerId = provider.value;
					yield* requireProvider(workspaceId, providerId);
					if (yield* projectComputers.anyMadeBy(workspaceId, providerId)) {
						const configured = yield* providers.access(workspaceId, providerId);
						if (!configured) return yield* new ComputersNotDestroyed({ reason: "incomplete" });
						yield* projectComputers
							.destroyAllMadeBy(workspaceId, configured)
							.pipe(
								Effect.mapError(
									(cause) => new ComputersNotDestroyed({ reason: "unavailable", cause }),
								),
							);
					}
					const removed = yield* transaction(
						Effect.andThen(
							ProjectComputers.lockProviderWithoutComputers(workspaceId, providerId),
							providers.remove(workspaceId, providerId),
						),
					);
					if (!removed) return yield* new ComputerProviderNotFound();
				}),
			),

		template: (_canManage, provider, target) =>
			operation(
				"template",
				Effect.gen(function* () {
					const workspaceId = target.workspace.value;
					const providerId = provider.value;
					const row = yield* requireProvider(workspaceId, providerId);
					const configured = yield* providers.access(workspaceId, providerId);
					const templates = configured && computers.forAccess(configured.access).templates;
					if (!templates) return { state: null };
					// A template Sugabots didn't build, though it has the name, may be
					// from any image, so it counts as missing until prepared here.
					const build = row.managedResources?.templateBuild;
					if (!build) return { state: "missing" };
					return { state: yield* templates.status(build) };
				}),
			),

		prepareTemplate: (_canManage, provider, target) =>
			operation(
				"prepareTemplate",
				Effect.gen(function* () {
					const workspaceId = target.workspace.value;
					const providerId = provider.value;
					yield* requireProvider(workspaceId, providerId);
					const configured = yield* providers.access(workspaceId, providerId);
					const templates = configured && computers.forAccess(configured.access).templates;
					if (!templates) return yield* new NoTemplates();
					// A registry that can't be asked leaves the image as it is named.
					const pinned = yield* Effect.tryPromise((signal) =>
						pinnedToDigest(COMPUTER_IMAGE, egress.providers, signal),
					).pipe(Effect.orElseSucceed(() => undefined));
					const build = yield* templates.build(pinned ?? COMPUTER_IMAGE);
					yield* providers.recordTemplateBuild(workspaceId, providerId, build);
					return { state: yield* templates.status(build) };
				}),
			),

		test: (_canManage, provider, target) =>
			operation(
				"test",
				Effect.gen(function* () {
					const workspaceId = target.workspace.value;
					const providerId = provider.value;
					yield* requireProvider(workspaceId, providerId);
					const configured = yield* providers.access(workspaceId, providerId);
					if (!configured) {
						return {
							reachable: false,
							latencyMs: 0,
							error: userText`Add the provider's settings before testing`,
						};
					}
					const tested = yield* timedTest(
						computers.forAccess(configured.access).check.pipe(
							Effect.as({}),
							Effect.catchTag("ComputerUnavailable", () =>
								Effect.succeed({
									error: userText`The provider didn't answer, or refused the key. Check its address and key.`,
								}),
							),
						),
					);
					yield* providers.recordTest(
						workspaceId,
						providerId,
						configured.configurationUpdatedAt,
						tested.error,
					);
					return tested;
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide([ComputerProviderStore.layer, ProjectComputers.layer, Computers.layer]),
);

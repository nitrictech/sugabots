export * as ComputerProviderSetup from "./computer-provider-setup.ts";

import type {
	ComputerProvider,
	ComputerProviderSettings,
	ComputerProviderTestResult,
	ComputerProviderUpdate,
	NewComputerProvider,
} from "@sugabots/contracts";
import { COMPUTER_IMAGE } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { Clock, Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { serviceOperations } from "../database/database.ts";
import { Egress } from "../providers/network/egress.ts";
import { requireAllowedUrl, type UrlNotAllowed } from "../providers/tested-configuration.ts";
import type { UserFacing } from "../user-message.ts";
import { BotComputers } from "./bot-computers.ts";
import { toComputerProvider } from "./computer-provider-reads.ts";
import { ComputerProviderRepository } from "./computer-provider-repository.ts";
import { Computers } from "./computers.ts";
import { pinnedToDigest } from "./image-digest.ts";

/**
 * Configuring where a workspace's computers run: checking addresses against
 * the egress policy before they are stored, trying a provider's account, and
 * removing a provider only once its computers are destroyed. Every method
 * takes the current actor's `workspace.providers.manage` on the workspace,
 * named by its id or its slug.
 */
export interface Interface {
	readonly list: (
		workspace: string,
	) => Effect.Effect<readonly ComputerProvider[], AuthorizationDenied, CurrentActor.Service>;
	/**
	 * Whether the workspace's bots can be given a computer. Takes only
	 * `workspace.read`, so a bot's settings can say why its switch is off.
	 */
	readonly access: (
		workspace: string,
	) => Effect.Effect<boolean, AuthorizationDenied, CurrentActor.Service>;
	readonly create: (input: {
		workspace: string;
		provider: NewComputerProvider;
	}) => Effect.Effect<
		ComputerProvider,
		AuthorizationDenied | UrlNotAllowed | ComputerProviderRepository.ComputerProviderIncomplete,
		CurrentActor.Service
	>;
	readonly update: (input: {
		workspace: string;
		providerId: string;
		changes: ComputerProviderUpdate;
	}) => Effect.Effect<
		ComputerProvider,
		| AuthorizationDenied
		| ComputerProviderNotFound
		| UrlNotAllowed
		| ComputerProviderRepository.ComputerProviderIncomplete
		| ComputerProviderRepository.ComputerProviderPresetFixed,
		CurrentActor.Service
	>;
	/** Destroys the provider's computers, then removes it. */
	readonly remove: (input: {
		workspace: string;
		providerId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | ComputerProviderNotFound | ComputersNotDestroyed,
		CurrentActor.Service
	>;
	/**
	 * How the provider's template stands, for a provider that builds its
	 * computers' template (E2B); `undefined` for one that takes images as they are.
	 */
	readonly templateStatus: (input: {
		workspace: string;
		providerId: string;
	}) => Effect.Effect<
		Computers.TemplateStatus | undefined,
		AuthorizationDenied | ComputerProviderNotFound | Computers.Unavailable,
		CurrentActor.Service
	>;
	/** Starts building the provider's template from Sugabots' computer image, in the workspace's own account. */
	readonly prepareTemplate: (input: {
		workspace: string;
		providerId: string;
	}) => Effect.Effect<
		Computers.TemplateStatus,
		AuthorizationDenied | ComputerProviderNotFound | NoTemplates | Computers.Unavailable,
		CurrentActor.Service
	>;
	/** Asks the provider whether it answers and accepts the key, and records how that went. */
	readonly test: (input: {
		workspace: string;
		providerId: string;
	}) => Effect.Effect<
		ComputerProviderTestResult,
		AuthorizationDenied | ComputerProviderNotFound,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ComputerProviderSetup",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ComputerProviderSetup");
	const authorization = yield* Authorization.Service;
	const providers = yield* ComputerProviderRepository.Service;
	const botComputers = yield* BotComputers.Service;
	const computers = yield* Computers.Service;
	const egress = yield* Egress.Service;

	const managed = (workspace: string) =>
		authorization.workspace(workspace, "workspace.providers.manage");

	const requireAllowedUrls = (settings: ComputerProviderSettings | undefined) =>
		Effect.forEach(
			settings ? ComputerProviderRepository.addressesIn(settings) : [],
			(url) => requireAllowedUrl(egress, url),
			{ discard: true },
		);

	const requireProvider = (workspaceId: string, providerId: string) =>
		Effect.flatMap(providers.list(workspaceId), (rows) => {
			const row = rows.find((candidate) => candidate.id === providerId);
			return row ? Effect.succeed(row) : Effect.fail(new ComputerProviderNotFound());
		});

	return Service.of({
		list: (workspace) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspace);
					return (yield* providers.list(workspaceId)).map(toComputerProvider);
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
					// Checked as it will be stored, with the usual address filled in.
					yield* requireAllowedUrls(ComputerProviderRepository.withUsualAddress(provider.settings));
					return toComputerProvider(
						yield* providers.create(workspaceId, { createdById: actor.userId, provider }),
					);
				}),
			),

		update: ({ workspace, providerId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspace);
					yield* requireAllowedUrls(changes.settings);
					const before = yield* requireProvider(workspaceId, providerId);
					const updated = yield* providers.update(workspaceId, providerId, changes);
					if (!updated) return yield* new ComputerProviderNotFound();
					const modeOf = (row: typeof before) =>
						ComputerProviderRepository.networkModeIn(row.settings);
					if (modeOf(updated) !== modeOf(before)) {
						yield* botComputers.applyNetwork({ workspaceId });
					}
					return toComputerProvider(updated);
				}),
			),

		remove: ({ workspace, providerId }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspace);
					yield* requireProvider(workspaceId, providerId);
					if (yield* botComputers.anyMadeBy(workspaceId, providerId)) {
						const configured = yield* providers.connection(workspaceId, providerId);
						if (!configured) return yield* new ComputersNotDestroyed({ cause: "incomplete" });
						yield* botComputers
							.destroyAllMadeBy(workspaceId, configured)
							.pipe(Effect.mapError((cause) => new ComputersNotDestroyed({ cause })));
					}
					if (!(yield* providers.remove(workspaceId, providerId))) {
						return yield* new ComputerProviderNotFound();
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
					const templates = configured && computers.forConnection(configured.connection).templates;
					if (!templates) return undefined;
					// A template Sugabots didn't build, though it has the name, may be
					// from any image, so it counts as missing until prepared here.
					const build = row.managedResources?.templateBuild;
					if (!build) return "missing";
					return yield* templates.status(build);
				}),
			),

		prepareTemplate: ({ workspace, providerId }) =>
			operation(
				"prepareTemplate",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspace);
					yield* requireProvider(workspaceId, providerId);
					const configured = yield* providers.connection(workspaceId, providerId);
					const templates = configured && computers.forConnection(configured.connection).templates;
					if (!templates) return yield* new NoTemplates();
					const pinned = yield* Effect.promise(() =>
						pinnedToDigest(COMPUTER_IMAGE, egress.providers).catch(() => undefined),
					);
					const image = pinned ?? COMPUTER_IMAGE;
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
							error: userText`Add the provider's settings before testing`,
						};
					}
					const started = yield* Clock.currentTimeMillis;
					const failure = yield* computers.forConnection(configured.connection).check.pipe(
						Effect.as(undefined),
						Effect.catchTag("ComputerUnavailable", () =>
							Effect.succeed(
								userText`The provider didn't answer, or refused the key. Check its address and key.`,
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
		ComputerProviderRepository.layer,
		BotComputers.layer,
		Computers.layer,
	]),
);

/** The provider takes images as they are, or lacks the settings to build a template with. */
export class NoTemplates extends Data.TaggedError("NoTemplates") implements UserFacing {
	get userMessage() {
		return userText`This provider has no template to prepare. Add its key first, if it needs one.`;
	}
}

export class ComputerProviderNotFound
	extends Data.TaggedError("ComputerProviderNotFound")
	implements UserFacing
{
	get userMessage() {
		return userText`This workspace has no such computer provider`;
	}
}

/**
 * The provider's computers couldn't be destroyed, so it was kept: removing it
 * would leave them running at the provider with nothing to remove them.
 */
export class ComputersNotDestroyed
	extends Data.TaggedError("ComputersNotDestroyed")<{
		cause: Computers.Unavailable | "incomplete";
	}>
	implements UserFacing
{
	get userMessage() {
		return this.cause === "incomplete"
			? userText`This provider still has computers, and needs its settings to remove them. Restore its key or address, then remove it.`
			: userText`This provider's computers couldn't be removed because it didn't answer. Try again when it's reachable.`;
	}
}

export * as SandboxProviderRepository from "./sandbox-provider-repository.ts";

import type {
	NewSandboxProvider,
	SandboxProviderSettings,
	SandboxProviderUpdate,
} from "@sugabots/contracts";
import { SANDBOX_E2B_DEFAULT_SIZE, sandboxProviderPreset } from "@sugabots/contracts";
import { and, asc, eq, ne } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer, Redacted } from "effect";
import { Credentials } from "../credentials/credentials.ts";
import { query, serviceOperations, transaction, writtenRow } from "../database/database.ts";
import { type SandboxProviderRow, sandboxProvider } from "../database/schema.ts";
import { stillConfiguredAs } from "../providers/tested-configuration.ts";
import { type UserFacing, UserMessage } from "../user-message.ts";
import type { Sandboxes } from "./sandboxes.ts";

/**
 * The only writer of `sandbox_provider`: the sandbox providers a workspace
 * has configured. At most one is enabled, and enabling one disables the
 * others. A provider is never enabled without what it needs to make a
 * sandbox, such as its key.
 */
export interface Interface {
	readonly list: (workspaceId: string) => Effect.Effect<readonly SandboxProviderRow[]>;
	readonly create: (
		workspaceId: string,
		input: { createdById: string; provider: NewSandboxProvider },
	) => Effect.Effect<SandboxProviderRow, SandboxProviderIncomplete>;
	readonly update: (
		workspaceId: string,
		providerId: string,
		changes: SandboxProviderUpdate,
	) => Effect.Effect<
		SandboxProviderRow | undefined,
		SandboxProviderIncomplete | SandboxProviderPresetFixed
	>;
	/** Deletes the row. Its sandboxes must have been destroyed first. */
	readonly remove: (workspaceId: string, providerId: string) => Effect.Effect<boolean>;
	/**
	 * Records how a test of the configuration last updated at `testedAt`
	 * went, `error` saying why it failed, unless the provider has been
	 * reconfigured since.
	 */
	readonly recordTest: (
		workspaceId: string,
		providerId: string,
		testedAt: Date,
		error?: UserMessage,
	) => Effect.Effect<void>;
	/** Remembers the template build Sugabots last started for the provider, until its settings or key change. */
	readonly recordTemplateBuild: (
		workspaceId: string,
		providerId: string,
		build: Sandboxes.TemplateBuild,
	) => Effect.Effect<void>;
	/** How to reach the provider, enabled or not, for a test; nothing while it lacks a setting it needs. */
	readonly connection: (
		workspaceId: string,
		providerId: string,
	) => Effect.Effect<Configured | undefined>;
	/** The provider that makes the workspace's sandboxes, or nothing when none is enabled. */
	readonly enabled: (workspaceId: string) => Effect.Effect<Configured | undefined>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/SandboxProviderRepository",
) {}

/** A provider row as something to make sandboxes with. */
export interface Configured {
	readonly id: string;
	readonly connection: Sandboxes.Connection;
	/** So a test result is recorded against the configuration it tested. */
	readonly configurationUpdatedAt: Date;
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("SandboxProviderRepository");
	const cipher = yield* Credentials.Service;

	const toConfigured = (row: SandboxProviderRow): Configured | undefined => {
		const connection = toConnection(row);
		return connection && { id: row.id, connection, configurationUpdatedAt: row.updatedAt };
	};

	const toConnection = (row: SandboxProviderRow): Sandboxes.Connection | undefined => {
		if (!row.apiKeyEncrypted) return undefined;
		const apiKey = Redacted.make(cipher.decrypt(row.apiKeyEncrypted));
		const settings = row.settings;
		const defaultImage = sandboxProviderPreset(settings.preset).defaultImage;
		switch (settings.preset) {
			case "opensandbox":
				return settings.serverUrl
					? {
							provider: "opensandbox",
							baseUrl: settings.serverUrl,
							apiKey,
							image: settings.image ?? defaultImage,
						}
					: undefined;
			case "e2b":
				return {
					provider: "e2b",
					apiKey,
					template: settings.template ?? defaultImage,
					size: {
						cpuCount: settings.cpuCount ?? SANDBOX_E2B_DEFAULT_SIZE.cpuCount,
						memoryGiB: settings.memoryGiB ?? SANDBOX_E2B_DEFAULT_SIZE.memoryGiB,
					},
					...(settings.apiUrl && settings.sandboxUrl
						? { endpoints: { apiUrl: settings.apiUrl, sandboxUrl: settings.sandboxUrl } }
						: {}),
				};
		}
	};

	const load = (workspaceId: string, providerId: string) =>
		query((db) =>
			db
				.select()
				.from(sandboxProvider)
				.where(
					and(eq(sandboxProvider.workspaceId, workspaceId), eq(sandboxProvider.id, providerId)),
				)
				.limit(1),
		).pipe(Effect.map(([row]) => row));

	/** Disables the workspace's other providers, so this one can be the enabled one. */
	const disableOthers = (workspaceId: string, providerId?: string) =>
		query((db) =>
			db
				.update(sandboxProvider)
				.set({ enabled: false })
				.where(
					and(
						eq(sandboxProvider.workspaceId, workspaceId),
						eq(sandboxProvider.enabled, true),
						...(providerId ? [ne(sandboxProvider.id, providerId)] : []),
					),
				),
		);

	return Service.of({
		list: (workspaceId) =>
			operation(
				"list",
				query((db) =>
					db
						.select()
						.from(sandboxProvider)
						.where(eq(sandboxProvider.workspaceId, workspaceId))
						.orderBy(asc(sandboxProvider.createdAt)),
				),
			),

		create: (workspaceId, { createdById, provider }) =>
			operation(
				"create",
				transaction(
					Effect.gen(function* () {
						const values = {
							workspaceId,
							createdById,
							settings: withUsualAddress(provider.settings),
							apiKeyEncrypted: provider.apiKey ? cipher.encrypt(provider.apiKey) : null,
							enabled: provider.enabled ?? false,
						};
						yield* requireComplete(values);
						if (values.enabled) yield* disableOthers(workspaceId);
						return yield* query((db) => db.insert(sandboxProvider).values(values).returning()).pipe(
							Effect.flatMap(writtenRow("sandbox_provider")),
						);
					}),
				),
			),

		update: (workspaceId, providerId, changes) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						const current = yield* load(workspaceId, providerId);
						if (!current) return undefined;
						if (changes.settings && changes.settings.preset !== current.preset) {
							return yield* new SandboxProviderPresetFixed();
						}
						// A key goes only where it was given for: one kept when an address
						// changes would be sent to the new address, which whoever changed
						// it may own.
						const addressMoved =
							changes.settings !== undefined &&
							addressesIn(changes.settings).join() !== addressesIn(current.settings).join();
						const values = {
							...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
							...(changes.settings ? { settings: changes.settings } : {}),
							...(changes.apiKey !== undefined
								? { apiKeyEncrypted: changes.apiKey ? cipher.encrypt(changes.apiKey) : null }
								: addressMoved
									? { apiKeyEncrypted: null }
									: {}),
						};
						const next = { ...current, ...values };
						// Taking away what it needs disables it, rather than refusing the change.
						const complete = isComplete(next);
						if (next.enabled && !complete) {
							if (changes.enabled) return yield* incompleteFor(next);
							next.enabled = false;
						}
						if (next.enabled) yield* disableOthers(workspaceId, providerId);
						return yield* query((db) =>
							db
								.update(sandboxProvider)
								.set({
									...values,
									enabled: next.enabled,
									// What Sugabots made for other settings or another account
									// says nothing about the ones now configured.
									...(changes.settings || changes.apiKey !== undefined
										? { managedResources: null }
										: {}),
								})
								.where(eq(sandboxProvider.id, providerId))
								.returning(),
						).pipe(Effect.flatMap(writtenRow("sandbox_provider")));
					}),
				),
			),

		remove: (workspaceId, providerId) =>
			operation(
				"remove",
				query((db) =>
					db
						.delete(sandboxProvider)
						.where(
							and(eq(sandboxProvider.workspaceId, workspaceId), eq(sandboxProvider.id, providerId)),
						)
						.returning({ id: sandboxProvider.id }),
				).pipe(Effect.map((rows) => rows.length > 0)),
			),

		recordTest: (workspaceId, providerId, testedAt, error) =>
			operation(
				"recordTest",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					yield* query((db) =>
						db
							.update(sandboxProvider)
							.set({ lastTestedAt: now, lastTestError: error ?? null })
							.where(
								and(
									eq(sandboxProvider.workspaceId, workspaceId),
									eq(sandboxProvider.id, providerId),
									stillConfiguredAs(sandboxProvider.updatedAt, testedAt),
								),
							),
					);
				}),
			),

		recordTemplateBuild: (workspaceId, providerId, build) =>
			operation(
				"recordTemplateBuild",
				query((db) =>
					db
						.update(sandboxProvider)
						.set({ managedResources: { preset: "e2b", templateBuild: build } })
						.where(
							and(eq(sandboxProvider.workspaceId, workspaceId), eq(sandboxProvider.id, providerId)),
						),
				).pipe(Effect.asVoid),
			),

		connection: (workspaceId, providerId) =>
			operation(
				"connection",
				Effect.map(load(workspaceId, providerId), (row) => row && toConfigured(row)),
			),

		enabled: (workspaceId) =>
			operation(
				"enabled",
				query((db) =>
					db
						.select()
						.from(sandboxProvider)
						.where(
							and(eq(sandboxProvider.workspaceId, workspaceId), eq(sandboxProvider.enabled, true)),
						)
						.limit(1),
				).pipe(Effect.map(([row]) => row && toConfigured(row))),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps;

type Provider = Pick<SandboxProviderRow, "settings" | "apiKeyEncrypted" | "enabled">;

/** Whether the provider has everything it needs to make a sandbox. */
export function isComplete({ settings, apiKeyEncrypted }: Omit<Provider, "enabled">): boolean {
	if (!apiKeyEncrypted) return false;
	switch (settings.preset) {
		case "opensandbox":
			return settings.serverUrl !== undefined;
		case "e2b":
			// E2B Embed needs both of its addresses; E2B Cloud needs neither.
			return (settings.apiUrl === undefined) === (settings.sandboxUrl === undefined);
	}
}

function requireComplete(provider: Provider) {
	return provider.enabled && !isComplete(provider) ? incompleteFor(provider) : Effect.void;
}

function incompleteFor({ settings, apiKeyEncrypted }: Provider) {
	return Effect.fail(
		new SandboxProviderIncomplete({
			missing:
				apiKeyEncrypted === null
					? "key"
					: settings.preset === "opensandbox"
						? "address"
						: "addresses",
		}),
	);
}

/** The addresses the settings point Sugabots at, which egress must allow. */
export function addressesIn(settings: SandboxProviderSettings): string[] {
	const addresses =
		settings.preset === "opensandbox"
			? [settings.serverUrl]
			: [settings.apiUrl, settings.sandboxUrl];
	return addresses.filter((address) => address !== undefined);
}

/** OpenSandbox at the address it's usually at, when none is given. */
export function withUsualAddress(settings: SandboxProviderSettings): SandboxProviderSettings {
	if (settings.preset !== "opensandbox" || settings.serverUrl) return settings;
	return { ...settings, serverUrl: sandboxProviderPreset(settings.preset).baseUrl };
}

/** Enabling a provider that lacks a setting it needs to make sandboxes. */
export class SandboxProviderIncomplete
	extends Data.TaggedError("SandboxProviderIncomplete")<{
		missing: "key" | "address" | "addresses";
	}>
	implements UserFacing
{
	get userMessage() {
		return MISSING_SETTING[this.missing];
	}
}

const MISSING_SETTING = {
	key: UserMessage.of`Add an API key before enabling this provider`,
	address: UserMessage.of`Add the server's address before enabling this provider`,
	addresses: UserMessage.of`E2B Embed needs both its API and sandbox addresses`,
} satisfies Record<SandboxProviderIncomplete["missing"], UserMessage>;

/** Settings for another preset than the provider's, which is fixed when it's made. */
export class SandboxProviderPresetFixed
	extends Data.TaggedError("SandboxProviderPresetFixed")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`A provider's type can't be changed. Add a provider of the other type instead.`;
	}
}

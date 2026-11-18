export * as ComputerProviderRepository from "./computer-provider-repository.ts";

import type {
	ComputerNetworkMode,
	ComputerProviderSettings,
	ComputerProviderUpdate,
	NewComputerProvider,
} from "@sugabots/contracts";
import { COMPUTER_NETWORK_MODE_DEFAULT, computerProviderPreset } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { and, asc, eq, ne } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer, Redacted } from "effect";
import { Credentials } from "../credentials/credentials.ts";
import { query, serviceOperations, transaction, writtenRow } from "../database/database.ts";
import { type ComputerProviderRow, computerProvider } from "../database/schema.ts";
import { stillConfiguredAs } from "../providers/tested-configuration.ts";
import type { UserFacing } from "../user-message.ts";
import type { Computers } from "./computers.ts";

/**
 * The only writer of `computer_provider`: the computer providers a workspace
 * has configured. At most one is enabled, and enabling one disables the
 * others. A provider is never enabled without what it needs to make a
 * computer, such as its key.
 */
export interface Interface {
	readonly list: (workspaceId: string) => Effect.Effect<readonly ComputerProviderRow[]>;
	readonly create: (
		workspaceId: string,
		input: { createdById: string; provider: NewComputerProvider },
	) => Effect.Effect<ComputerProviderRow, ComputerProviderIncomplete>;
	readonly update: (
		workspaceId: string,
		providerId: string,
		changes: ComputerProviderUpdate,
	) => Effect.Effect<
		ComputerProviderRow | undefined,
		ComputerProviderIncomplete | ComputerProviderPresetFixed
	>;
	/** Deletes the row. Its computers must have been destroyed first. */
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
		error?: UserText,
	) => Effect.Effect<void>;
	/** Remembers the template build Sugabots last started for the provider, until its settings or key change. */
	readonly recordTemplateBuild: (
		workspaceId: string,
		providerId: string,
		build: Computers.TemplateBuild,
	) => Effect.Effect<void>;
	/** How to reach the provider, enabled or not, for a test; nothing while it lacks a setting it needs. */
	readonly connection: (
		workspaceId: string,
		providerId: string,
	) => Effect.Effect<Configured | undefined>;
	/** The provider that makes the workspace's computers, or nothing when none is enabled. */
	readonly enabled: (workspaceId: string) => Effect.Effect<Configured | undefined>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ComputerProviderRepository",
) {}

/** A provider row as something to make computers with. */
export interface Configured {
	readonly id: string;
	readonly connection: Computers.Connection;
	/** So a test result is recorded against the configuration it tested. */
	readonly configurationUpdatedAt: Date;
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ComputerProviderRepository");
	const cipher = yield* Credentials.Service;

	const toConfigured = (row: ComputerProviderRow): Configured | undefined => {
		const connection = toConnection(row);
		return connection && { id: row.id, connection, configurationUpdatedAt: row.updatedAt };
	};

	const toConnection = (row: ComputerProviderRow): Computers.Connection | undefined =>
		row.apiKeyEncrypted
			? connectionOf(row.settings, Redacted.make(cipher.decrypt(row.apiKeyEncrypted)))
			: undefined;

	const load = (workspaceId: string, providerId: string) =>
		query((db) =>
			db
				.select()
				.from(computerProvider)
				.where(
					and(eq(computerProvider.workspaceId, workspaceId), eq(computerProvider.id, providerId)),
				)
				.limit(1),
		).pipe(Effect.map(([row]) => row));

	/** Disables the workspace's other providers, so this one can be the enabled one. */
	const disableOthers = (workspaceId: string, providerId?: string) =>
		query((db) =>
			db
				.update(computerProvider)
				.set({ enabled: false })
				.where(
					and(
						eq(computerProvider.workspaceId, workspaceId),
						eq(computerProvider.enabled, true),
						...(providerId ? [ne(computerProvider.id, providerId)] : []),
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
						.from(computerProvider)
						.where(eq(computerProvider.workspaceId, workspaceId))
						.orderBy(asc(computerProvider.createdAt)),
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
						return yield* query((db) =>
							db.insert(computerProvider).values(values).returning(),
						).pipe(Effect.flatMap(writtenRow("computer_provider")));
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
							return yield* new ComputerProviderPresetFixed();
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
								.update(computerProvider)
								.set({
									...values,
									enabled: next.enabled,
									// What Sugabots made for other settings or another account
									// says nothing about the ones now configured.
									...(changes.settings || changes.apiKey !== undefined
										? { managedResources: null }
										: {}),
								})
								.where(eq(computerProvider.id, providerId))
								.returning(),
						).pipe(Effect.flatMap(writtenRow("computer_provider")));
					}),
				),
			),

		remove: (workspaceId, providerId) =>
			operation(
				"remove",
				query((db) =>
					db
						.delete(computerProvider)
						.where(
							and(
								eq(computerProvider.workspaceId, workspaceId),
								eq(computerProvider.id, providerId),
							),
						)
						.returning({ id: computerProvider.id }),
				).pipe(Effect.map((rows) => rows.length > 0)),
			),

		recordTest: (workspaceId, providerId, testedAt, error) =>
			operation(
				"recordTest",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					yield* query((db) =>
						db
							.update(computerProvider)
							.set({ lastTestedAt: now, lastTestError: error ?? null })
							.where(
								and(
									eq(computerProvider.workspaceId, workspaceId),
									eq(computerProvider.id, providerId),
									stillConfiguredAs(computerProvider.updatedAt, testedAt),
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
						.update(computerProvider)
						.set({ managedResources: { preset: "e2b", templateBuild: build } })
						.where(
							and(
								eq(computerProvider.workspaceId, workspaceId),
								eq(computerProvider.id, providerId),
							),
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
						.from(computerProvider)
						.where(
							and(
								eq(computerProvider.workspaceId, workspaceId),
								eq(computerProvider.enabled, true),
							),
						)
						.limit(1),
				).pipe(Effect.map(([row]) => row && toConfigured(row))),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps;

type Provider = Pick<ComputerProviderRow, "settings" | "apiKeyEncrypted" | "enabled">;

/** How to reach a provider configured with `settings` and `apiKey`; nothing while it lacks a setting it needs. */
export function connectionOf(
	settings: ComputerProviderSettings,
	apiKey: Redacted.Redacted<string>,
): Computers.Connection | undefined {
	const { defaultImage, defaultSize } = computerProviderPreset(settings.preset);
	switch (settings.preset) {
		case "opensandbox":
			return settings.serverUrl
				? {
						provider: "opensandbox",
						baseUrl: settings.serverUrl,
						apiKey,
						image: settings.image ?? defaultImage,
						size: sizeIn(settings, defaultSize),
						networkMode: networkModeIn(settings),
					}
				: undefined;
		case "e2b":
			return {
				provider: "e2b",
				apiKey,
				template: settings.template ?? defaultImage,
				networkMode: networkModeIn(settings),
				size: sizeIn(settings, defaultSize),
				...(settings.apiUrl && settings.sandboxUrl
					? { endpoints: { apiUrl: settings.apiUrl, sandboxUrl: settings.sandboxUrl } }
					: {}),
			};
	}
}

/** Whether the provider has everything it needs to make a computer. */
function isComplete({ settings, apiKeyEncrypted }: Omit<Provider, "enabled">): boolean {
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
		new ComputerProviderIncomplete({
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
export function addressesIn(settings: ComputerProviderSettings): string[] {
	const addresses =
		settings.preset === "opensandbox"
			? [settings.serverUrl]
			: [settings.apiUrl, settings.sandboxUrl];
	return addresses.filter((address) => address !== undefined);
}

/** OpenSandbox at the address it's usually at, when none is given. */
/** How the provider's computers reach the internet, by its settings or the default. */
export function networkModeIn(settings: ComputerProviderSettings): ComputerNetworkMode {
	return settings.networkMode ?? COMPUTER_NETWORK_MODE_DEFAULT;
}

/** The most each of the provider's computers may use, by its settings or its preset's default. */
function sizeIn(
	settings: { cpuCount?: number; memoryGiB?: number },
	defaultSize: Computers.Size,
): Computers.Size {
	return {
		cpuCount: settings.cpuCount ?? defaultSize.cpuCount,
		memoryGiB: settings.memoryGiB ?? defaultSize.memoryGiB,
	};
}

export function withUsualAddress(settings: ComputerProviderSettings): ComputerProviderSettings {
	if (settings.preset !== "opensandbox" || settings.serverUrl) return settings;
	return { ...settings, serverUrl: computerProviderPreset(settings.preset).baseUrl };
}

/** Enabling a provider that lacks a setting it needs to make computers. */
export class ComputerProviderIncomplete
	extends Data.TaggedError("ComputerProviderIncomplete")<{
		missing: "key" | "address" | "addresses";
	}>
	implements UserFacing
{
	get userMessage() {
		return MISSING_SETTING[this.missing];
	}
}

const MISSING_SETTING = {
	key: userText`Add an API key before enabling this provider`,
	address: userText`Add the server's address before enabling this provider`,
	addresses: userText`E2B Embed needs both its API and computer addresses`,
} satisfies Record<ComputerProviderIncomplete["missing"], UserText>;

/** Settings for another preset than the provider's, which is fixed when it's made. */
export class ComputerProviderPresetFixed
	extends Data.TaggedError("ComputerProviderPresetFixed")
	implements UserFacing
{
	get userMessage() {
		return userText`A provider's type can't be changed. Add a provider of the other type instead.`;
	}
}

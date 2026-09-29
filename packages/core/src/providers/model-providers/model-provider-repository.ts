export * as ModelProviderRepository from "./model-provider-repository.ts";

import type {
	ModelProviderUpdate,
	NewModelProvider,
	ProviderModel,
	ProviderModelUpdate,
	ProviderPresetId,
} from "@sugabots/contracts";
import {
	presetRequiresApiKey,
	presetSignsIn,
	providerPreset,
	seededPresets,
} from "@sugabots/contracts";
import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer, Schema } from "effect";
import { Credentials } from "../../credentials/credentials.ts";
import { query, queryCatching, serviceOperations, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import {
	type ModelProviderRow,
	modelProvider,
	providerModel,
	workspaceDefaultModel,
} from "../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { stillConfiguredAs } from "../tested-configuration.ts";
import { ChatgptTokens } from "./chatgpt.ts";
import type { DiscoveredModel } from "./dialects/index.ts";

/**
 * The only writer of `model_provider`, `provider_model` and
 * `workspace_default_model`: a workspace's model providers, their sealed
 * credentials, the models each offers, and which of those is the default.
 *
 * A provider is switched on only by a successful test of its current
 * configuration, through `recordTest`; `update` can only switch it off, and a
 * new key switches it off until it has been tried.
 */
export interface Interface {
	/**
	 * Gives a workspace the starting providers it does not have yet, and brings
	 * their starter models up to date with the catalog. Safe to repeat.
	 */
	readonly seedPresets: (workspaceId: string) => Effect.Effect<void>;
	readonly create: (
		workspaceId: string,
		input: { createdById: string; provider: NewModelProvider },
	) => Effect.Effect<ModelProviderRow, ModelProviderNameConflict>;
	readonly update: (
		workspaceId: string,
		providerId: string,
		changes: SettingsChange,
	) => Effect.Effect<ModelProviderRow | undefined>;
	/** Only a custom provider goes; `false` for a seeded one or one that is not there. */
	readonly remove: (workspaceId: string, providerId: string) => Effect.Effect<boolean>;
	/**
	 * Signs a ChatGPT provider in with `tokens`, or out with null. Like a new
	 * key, it leaves the provider inactive and untested until it is tried.
	 */
	readonly saveChatgptSignIn: (
		workspaceId: string,
		providerId: string,
		tokens: ChatgptTokens | null,
	) => Effect.Effect<void>;
	/**
	 * Replaces a signed-in provider's tokens with what `renew` makes of them,
	 * holding its row locked meanwhile: a refresh token is good for one use, so
	 * two turns must not both spend it. Not a configuration change, so the
	 * provider's last test still stands. `undefined` if it is not signed in.
	 */
	readonly renewChatgptTokens: <E>(
		workspaceId: string,
		providerId: string,
		renew: (current: ChatgptTokens) => Effect.Effect<ChatgptTokens, E>,
	) => Effect.Effect<ChatgptTokens | undefined, E>;
	/**
	 * Records how a test of the configuration last updated at `testedAt` went,
	 * unless the provider has been reconfigured since. A failure switches the
	 * provider off; a success switches it on when `activateOnSuccess` asks.
	 */
	readonly recordTest: (
		workspaceId: string,
		providerId: string,
		testedAt: Date,
		outcome: { error: UserMessage } | { activateOnSuccess: boolean },
	) => Effect.Effect<void>;
	readonly addModels: (
		workspaceId: string,
		providerId: string,
		models: Array<Omit<ProviderModel, "id" | "enabled" | "disabledCapabilities">>,
	) => Effect.Effect<number>;
	/**
	 * Records what a provider says it offers: new models are added, and a
	 * fetched one whose name, capabilities or context length it now reports
	 * differently is brought up to date. A model somebody added by hand keeps
	 * what they wrote, and one another provider in the workspace already lists
	 * is left to it.
	 */
	readonly syncDiscovered: (
		workspaceId: string,
		providerId: string,
		models: DiscoveredModel[],
	) => Effect.Effect<{ added: number; updated: number }>;
	readonly setModelEnabled: (
		workspaceId: string,
		providerId: string,
		modelIds: string[],
		enabled: boolean,
	) => Effect.Effect<number>;
	/**
	 * One model's switch, the capabilities switched off for agents, or, for a
	 * model added by hand, what it can do; a fetched model's capabilities are
	 * the provider's to say, so `capabilities` changes only a manual one.
	 */
	readonly updateModel: (
		workspaceId: string,
		providerId: string,
		modelId: string,
		changes: ProviderModelUpdate,
	) => Effect.Effect<number>;
	/** Only a model added by hand goes. */
	readonly removeModel: (
		workspaceId: string,
		providerId: string,
		modelId: string,
	) => Effect.Effect<boolean>;
	/** How to reach a provider, or nothing while it lacks the key or sign-in its preset needs. */
	readonly endpoint: (
		workspaceId: string,
		providerId: string,
	) => Effect.Effect<ProviderEndpoint | undefined>;
	/** How to reach whichever provider offers `modelId`, while the workspace offers it. */
	readonly resolve: (
		workspaceId: string,
		modelId: string,
	) => Effect.Effect<ProviderEndpoint | undefined>;
	/**
	 * Whether the workspace offers a model: it is switched on, at a provider that
	 * is. The one rule for what an agent may run on.
	 */
	readonly isEnabled: (workspaceId: string, modelId: string) => Effect.Effect<boolean>;
	/** {@link Interface.isEnabled}, as a refusal. */
	readonly requireEnabled: (
		workspaceId: string,
		modelId: string,
	) => Effect.Effect<void, ModelNotEnabled>;
	/** The model the workspace's new agents start on, or nothing until it first offers one. */
	readonly defaultModel: (workspaceId: string) => Effect.Effect<string | undefined>;
	/**
	 * Makes `modelId` the default. Only inside `holdingModel` from
	 * `held-models.ts`, which checks the workspace offers it and keeps it so.
	 */
	readonly setDefaultModel: (workspaceId: string, modelId: string) => Effect.Effect<void>;
	/**
	 * The workspace's default, first making the model it has offered longest
	 * the default if it has none yet. Nothing while it offers no model. Only
	 * inside `withHeldModelsLocked` from `held-models.ts`.
	 */
	readonly ensureDefaultModel: (workspaceId: string) => Effect.Effect<string | undefined>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ModelProviderRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ModelProviderRepository");
	const cipher = yield* Credentials.Service;

	/**
	 * The catalog's starter models for the given presets, refreshed onto the
	 * workspace's providers made from them. Discovery replaces these once a key
	 * is in; until then they are what the picker has to offer.
	 */
	const ensureStarterModels = (workspaceId: string, presets: readonly ProviderPresetId[]) =>
		Effect.gen(function* () {
			const withModels = presets.filter((id) => providerPreset(id).models.length > 0);
			if (withModels.length === 0) return;
			const providers = yield* query((db) =>
				db
					.select({ id: modelProvider.id, preset: modelProvider.preset })
					.from(modelProvider)
					.where(
						and(
							eq(modelProvider.workspaceId, workspaceId),
							inArray(modelProvider.preset, withModels),
						),
					),
			);
			const models = providers.flatMap((provider) =>
				(provider.preset ? providerPreset(provider.preset).models : []).map((model) => ({
					...model,
					workspaceId,
					providerId: provider.id,
					enabled: false,
					source: "fetched" as const,
				})),
			);
			if (models.length === 0) return;
			yield* query((db) =>
				db
					.insert(providerModel)
					.values(models)
					.onConflictDoUpdate({
						target: [providerModel.providerId, providerModel.modelId],
						set: {
							displayName: sql`excluded.display_name`,
							capabilities: sql`excluded.capabilities`,
							contextLength: sql`excluded.context_length`,
						},
					}),
			);
		});

	const endpoint = (workspaceId: string, providerId: string) =>
		Effect.gen(function* () {
			const [row] = yield* query((db) =>
				db
					.select()
					.from(modelProvider)
					.where(and(eq(modelProvider.id, providerId), eq(modelProvider.workspaceId, workspaceId))),
			);
			if (!row || lacksCredential(row)) {
				return undefined;
			}
			return {
				providerId: row.id,
				preset: row.preset,
				baseUrl: row.baseUrl,
				apiFormat: row.apiFormat,
				apiKey: row.apiKeyEncrypted ? cipher.decrypt(row.apiKeyEncrypted) : undefined,
				chatgptTokens: row.chatgptTokensEncrypted
					? openChatgptTokens(row.chatgptTokensEncrypted, cipher)
					: undefined,
				configurationUpdatedAt: row.updatedAt,
				headers: Object.fromEntries(
					row.customHeadersEncrypted.map(({ name, value }) => [name, cipher.decrypt(value)]),
				),
			} satisfies ProviderEndpoint;
		});

	const isEnabled = (workspaceId: string, modelId: string) =>
		query((db) =>
			db
				.select({ id: providerModel.id })
				.from(providerModel)
				.innerJoin(modelProvider, eq(modelProvider.id, providerModel.providerId))
				.where(and(offeredIn(workspaceId), eq(providerModel.modelId, modelId)))
				.limit(1),
		).pipe(Effect.map(([row]) => row !== undefined));

	return Service.of({
		seedPresets: (workspaceId) =>
			operation(
				"seedPresets",
				Effect.gen(function* () {
					const providers = seededPresets.map((id) => {
						const { name, baseUrl, apiFormat } = providerPreset(id);
						return { workspaceId, preset: id, name, baseUrl, apiFormat };
					});
					yield* query((db) => db.insert(modelProvider).values(providers).onConflictDoNothing());
					yield* ensureStarterModels(workspaceId, seededPresets);
				}),
			),

		create: (workspaceId, { createdById, provider }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const [inserted] = yield* queryCatching(
						(db) =>
							db
								.insert(modelProvider)
								.values({ workspaceId, createdById, ...providerValues(provider, cipher) })
								.returning(),
						(failure) => (isUniqueViolation(failure) ? new ModelProviderNameConflict() : undefined),
					);
					if (!inserted) {
						return yield* Effect.die(new Error("Provider insert returned no row"));
					}
					if (inserted.preset) {
						yield* ensureStarterModels(workspaceId, [inserted.preset]);
					}
					return inserted;
				}),
			),

		update: (workspaceId, providerId, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					const configurationChanged =
						changes.baseUrl !== undefined ||
						changes.apiFormat !== undefined ||
						changes.apiKey !== undefined ||
						changes.customHeaders !== undefined;
					const values = {
						// A new key is on only once a test of it has succeeded.
						active: changes.apiKey !== undefined ? false : changes.active,
						baseUrl: changes.baseUrl,
						apiFormat: changes.apiFormat,
						apiKeyEncrypted: storedApiKey(changes.apiKey, cipher),
						customHeadersEncrypted: changes.customHeaders?.map(({ name, value }) => ({
							name,
							value: cipher.encrypt(value),
						})),
						lastTestedAt: configurationChanged ? null : undefined,
						lastTestError: configurationChanged ? null : undefined,
					};
					const inProvider = and(
						eq(modelProvider.id, providerId),
						eq(modelProvider.workspaceId, workspaceId),
					);
					// An UPDATE must set something, and a change may name nothing this writes.
					const [row] = Object.values(values).some((value) => value !== undefined)
						? yield* query((db) =>
								db.update(modelProvider).set(values).where(inProvider).returning(),
							)
						: yield* query((db) => db.select().from(modelProvider).where(inProvider));
					return row;
				}),
			),

		remove: (workspaceId, providerId) =>
			operation(
				"remove",
				query((db) =>
					db
						.delete(modelProvider)
						.where(
							and(
								eq(modelProvider.id, providerId),
								eq(modelProvider.workspaceId, workspaceId),
								or(
									isNull(modelProvider.preset),
									notInArray(modelProvider.preset, [...seededPresets]),
								),
							),
						)
						.returning({ id: modelProvider.id }),
				).pipe(Effect.map((rows) => rows.length > 0)),
			),

		saveChatgptSignIn: (workspaceId, providerId, tokens) =>
			operation(
				"saveChatgptSignIn",
				query((db) =>
					db
						.update(modelProvider)
						.set({
							active: false,
							chatgptTokensEncrypted: tokens ? cipher.encrypt(JSON.stringify(tokens)) : null,
							lastTestedAt: null,
							lastTestError: null,
						})
						.where(
							and(eq(modelProvider.id, providerId), eq(modelProvider.workspaceId, workspaceId)),
						),
				),
			),

		renewChatgptTokens: (workspaceId, providerId, renew) =>
			operation(
				"renewChatgptTokens",
				transaction(
					Effect.gen(function* () {
						const [row] = yield* query((db) =>
							db
								.select({
									sealed: modelProvider.chatgptTokensEncrypted,
									updatedAt: modelProvider.updatedAt,
								})
								.from(modelProvider)
								.where(
									and(eq(modelProvider.id, providerId), eq(modelProvider.workspaceId, workspaceId)),
								)
								.for("update"),
						);
						if (!row?.sealed) return undefined;
						const current = openChatgptTokens(row.sealed, cipher);
						const renewed = yield* renew(current);
						if (renewed === current) return current;
						yield* query((db) =>
							db
								.update(modelProvider)
								// Kept as it was, so a test of the configuration still records against it.
								.set({
									chatgptTokensEncrypted: cipher.encrypt(JSON.stringify(renewed)),
									updatedAt: row.updatedAt,
								})
								.where(eq(modelProvider.id, providerId)),
						);
						return renewed;
					}),
				),
			),

		recordTest: (workspaceId, providerId, testedAt, outcome) =>
			operation(
				"recordTest",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					yield* query((db) =>
						db
							.update(modelProvider)
							.set({
								lastTestedAt: now,
								lastTestError: "error" in outcome ? outcome.error : null,
								active: "error" in outcome ? false : outcome.activateOnSuccess ? true : undefined,
							})
							.where(
								and(
									eq(modelProvider.id, providerId),
									eq(modelProvider.workspaceId, workspaceId),
									stillConfiguredAs(modelProvider.updatedAt, testedAt),
								),
							),
					);
				}),
			),

		addModels: (workspaceId, providerId, models) =>
			operation(
				"addModels",
				Effect.gen(function* () {
					if (models.length === 0) return 0;
					const rows = models.map((model) => ({
						...model,
						workspaceId,
						providerId,
						enabled: false,
					}));
					const inserted = yield* query((db) =>
						db
							.insert(providerModel)
							.values(rows)
							.onConflictDoNothing()
							.returning({ id: providerModel.id }),
					);
					return inserted.length;
				}),
			),

		syncDiscovered: (workspaceId, providerId, models) =>
			operation(
				"syncDiscovered",
				Effect.gen(function* () {
					if (models.length === 0) return { added: 0, updated: 0 };
					const elsewhere = yield* query((db) =>
						db
							.select({ modelId: providerModel.modelId })
							.from(providerModel)
							.where(
								and(
									eq(providerModel.workspaceId, workspaceId),
									ne(providerModel.providerId, providerId),
									inArray(
										providerModel.modelId,
										models.map(({ modelId }) => modelId),
									),
								),
							),
					);
					const claimed = new Set(elsewhere.map(({ modelId }) => modelId));
					const offered = models
						.filter(({ modelId }) => !claimed.has(modelId))
						.map((model) => ({
							...model,
							workspaceId,
							providerId,
							enabled: false,
							source: "fetched" as const,
						}));
					if (offered.length === 0) return { added: 0, updated: 0 };
					const rows = yield* query((db) =>
						db
							.insert(providerModel)
							.values(offered)
							.onConflictDoUpdate({
								target: [providerModel.providerId, providerModel.modelId],
								set: {
									displayName: sql`excluded.display_name`,
									capabilities: sql`excluded.capabilities`,
									contextLength: sql`excluded.context_length`,
								},
								setWhere: sql`${providerModel.source} = 'fetched' and (${providerModel.displayName} is distinct from excluded.display_name or ${providerModel.capabilities} is distinct from excluded.capabilities or ${providerModel.contextLength} is distinct from excluded.context_length)`,
							})
							// Postgres leaves xmax at zero on a row this statement inserted.
							.returning({ inserted: sql<boolean>`(xmax = 0)` }),
					);
					const added = rows.filter(({ inserted }) => inserted).length;
					return { added, updated: rows.length - added };
				}),
			),

		setModelEnabled: (workspaceId, providerId, modelIds, enabled) =>
			operation(
				"setModelEnabled",
				modelIds.length === 0
					? Effect.succeed(0)
					: query((db) =>
							db
								.update(providerModel)
								.set({ enabled })
								.where(
									and(
										eq(providerModel.workspaceId, workspaceId),
										eq(providerModel.providerId, providerId),
										inArray(providerModel.id, modelIds),
									),
								)
								.returning({ id: providerModel.id }),
						).pipe(Effect.map((rows) => rows.length)),
			),

		updateModel: (workspaceId, providerId, modelId, changes) =>
			operation(
				"updateModel",
				query((db) =>
					db
						.update(providerModel)
						.set({
							enabled: changes.enabled,
							capabilities: changes.capabilities,
							disabledCapabilities: changes.disabledCapabilities,
						})
						.where(
							and(
								eq(providerModel.workspaceId, workspaceId),
								eq(providerModel.providerId, providerId),
								eq(providerModel.id, modelId),
								changes.capabilities === undefined ? undefined : eq(providerModel.source, "manual"),
							),
						)
						.returning({ id: providerModel.id }),
				).pipe(Effect.map((rows) => rows.length)),
			),

		removeModel: (workspaceId, providerId, modelId) =>
			operation(
				"removeModel",
				query((db) =>
					db
						.delete(providerModel)
						.where(
							and(
								eq(providerModel.workspaceId, workspaceId),
								eq(providerModel.providerId, providerId),
								eq(providerModel.id, modelId),
								eq(providerModel.source, "manual"),
							),
						)
						.returning({ id: providerModel.id }),
				).pipe(Effect.map((rows) => rows.length > 0)),
			),

		endpoint: (workspaceId, providerId) => operation("endpoint", endpoint(workspaceId, providerId)),

		resolve: (workspaceId, modelId) =>
			operation(
				"resolve",
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.select({ providerId: modelProvider.id })
							.from(providerModel)
							.innerJoin(modelProvider, eq(modelProvider.id, providerModel.providerId))
							.where(and(offeredIn(workspaceId), eq(providerModel.modelId, modelId))),
					);
					return row ? yield* endpoint(workspaceId, row.providerId) : undefined;
				}),
			),

		defaultModel: (workspaceId) => operation("defaultModel", defaultModelOf(workspaceId)),

		setDefaultModel: (workspaceId, modelId) =>
			operation(
				"setDefaultModel",
				query((db) =>
					db
						.insert(workspaceDefaultModel)
						.values({ workspaceId, modelId })
						.onConflictDoUpdate({ target: workspaceDefaultModel.workspaceId, set: { modelId } }),
				),
			),

		ensureDefaultModel: (workspaceId) =>
			operation(
				"ensureDefaultModel",
				Effect.gen(function* () {
					const current = yield* defaultModelOf(workspaceId);
					if (current !== undefined) return current;
					const [first] = yield* query((db) =>
						db
							.select({ modelId: providerModel.modelId })
							.from(providerModel)
							.innerJoin(modelProvider, eq(modelProvider.id, providerModel.providerId))
							.where(offeredIn(workspaceId))
							.orderBy(asc(providerModel.createdAt), asc(providerModel.id))
							.limit(1),
					);
					if (!first) return undefined;
					yield* query((db) =>
						db.insert(workspaceDefaultModel).values({ workspaceId, modelId: first.modelId }),
					);
					return first.modelId;
				}),
			),

		isEnabled: (workspaceId, modelId) => operation("isEnabled", isEnabled(workspaceId, modelId)),

		requireEnabled: (workspaceId, modelId) =>
			operation(
				"requireEnabled",
				Effect.flatMap(isEnabled(workspaceId, modelId), (enabled) =>
					enabled ? Effect.void : Effect.fail(new ModelNotEnabled({ model: modelId })),
				),
			),
	});
});

export const layer = Layer.effect(Service, make);

/**
 * What `update` may change. `active` may only be switched off here: a
 * provider is switched on by a successful test, through `recordTest`.
 */
export type SettingsChange = Omit<ModelProviderUpdate, "active"> & { readonly active?: false };

/** How to reach a provider: where, in which protocol, and with which credentials. */
export interface ProviderEndpoint {
	providerId: string;
	preset: ProviderPresetId | null;
	baseUrl: string;
	apiFormat: "openai" | "anthropic";
	apiKey?: string;
	headers: Record<string, string>;
	/**
	 * A signed-in ChatGPT provider's tokens, which stand in for its key. Use
	 * the endpoint through `withChatgptAccess`, which puts a live token in
	 * `apiKey`.
	 */
	chatgptTokens?: ChatgptTokens;
	/** The provider's `updatedAt`, so a test's result is recorded against what it tried. */
	configurationUpdatedAt: Date;
}

export class ModelProviderNameConflict
	extends Data.TaggedError("ModelProviderNameConflict")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`A model provider with that name already exists`;
	}
}

/** The workspace does not offer the model something was asked to run on. */
export class ModelNotEnabled
	extends Data.TaggedError("ModelNotEnabled")<{ readonly model: string }>
	implements UserFacing
{
	override get message() {
		return `This workspace does not offer the model "${this.model}"`;
	}
	get userMessage() {
		return UserMessage.of`This workspace does not offer that model`;
	}
}

/** The model the workspace's new agents start on, or nothing until it first offers one. */
export const defaultModelOf = (workspaceId: string) =>
	query((db) =>
		db
			.select({ modelId: workspaceDefaultModel.modelId })
			.from(workspaceDefaultModel)
			.where(eq(workspaceDefaultModel.workspaceId, workspaceId)),
	).pipe(Effect.map(([row]) => row?.modelId));

/**
 * A model the workspace offers, in a query joining `provider_model` to
 * `model_provider`: switched on, at a provider that is, both in the workspace,
 * and not an embedding model.
 */
export function offeredIn(workspaceId: string) {
	return and(
		eq(providerModel.workspaceId, workspaceId),
		eq(providerModel.enabled, true),
		eq(modelProvider.active, true),
		eq(modelProvider.workspaceId, workspaceId),
		notEmbedding,
	);
}

/**
 * An embedding model cannot hold a conversation, so no agent runs on one. It
 * is one while it has the capability and an admin has not switched it off.
 */
const notEmbedding = sql`not (${providerModel.capabilities} @> '["embeddings"]' and not ${providerModel.disabledCapabilities} @> '["embeddings"]')`;

/**
 * The row a new provider is inserted as. From a preset, the catalog supplies
 * the name, address and protocol and the caller only the key, and for a local
 * preset perhaps the address; a custom endpoint is described in full.
 */
function providerValues(input: NewModelProvider, cipher: Credentials.Interface) {
	const apiKeyEncrypted = input.apiKey ? cipher.encrypt(input.apiKey) : undefined;
	if ("preset" in input) {
		const { id, name, baseUrl, apiFormat } = providerPreset(input.preset);
		return {
			preset: id,
			name,
			baseUrl: input.baseUrl ?? baseUrl,
			apiFormat,
			apiKeyEncrypted,
			customHeadersEncrypted: [],
		};
	}
	return {
		preset: null,
		name: input.name,
		baseUrl: input.baseUrl,
		apiFormat: input.apiFormat,
		apiKeyEncrypted,
		customHeadersEncrypted: input.customHeaders.map(({ name, value }) => ({
			name,
			value: cipher.encrypt(value),
		})),
	};
}

/** What an update writes to the key column: absent leaves it, null clears it. */
function storedApiKey(apiKey: ModelProviderUpdate["apiKey"], cipher: Credentials.Interface) {
	if (apiKey === undefined) return undefined;
	return apiKey === null ? null : cipher.encrypt(apiKey);
}

/** A provider that cannot be used yet: it wants a key, or a sign-in, it has not had. */
export function lacksCredential(
	row: Pick<ModelProviderRow, "preset" | "apiKeyEncrypted" | "chatgptTokensEncrypted">,
): boolean {
	if (presetSignsIn(row.preset)) return row.chatgptTokensEncrypted === null;
	return presetRequiresApiKey(row.preset) && row.apiKeyEncrypted === null;
}

function openChatgptTokens(sealed: string, cipher: Credentials.Interface): ChatgptTokens {
	return Schema.decodeUnknownSync(ChatgptTokens)(JSON.parse(cipher.decrypt(sealed)));
}

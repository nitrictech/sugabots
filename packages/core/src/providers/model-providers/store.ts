import type {
	ModelProvider,
	ModelProviderUpdate,
	NewModelProvider,
	ProviderModel,
	ProviderModelUpdate,
	ProviderPresetId,
	WorkspaceModelsResponse,
} from "@sugabots/contracts";
import {
	effectiveCapabilities,
	presetRequiresApiKey,
	presetSignsIn,
	providerPreset,
	seededPresets,
} from "@sugabots/contracts";
import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { type Database, query, queryCatching, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import { modelProvider, providerModel } from "../../database/schema.ts";
import { ChatgptTokens } from "./chatgpt.ts";
import type { CredentialCipher } from "./credentials.ts";
import type { DiscoveredModel } from "./dialects/index.ts";

export interface ProviderConnection {
	providerId: string;
	preset: ProviderPresetId | null;
	baseUrl: string;
	apiFormat: "openai" | "anthropic";
	apiKey?: string;
	headers: Record<string, string>;
	/**
	 * A signed-in ChatGPT provider's tokens, which stand in for its key. Use
	 * the connection through `withChatgptAccess`, which puts a live token in
	 * `apiKey`.
	 */
	chatgptTokens?: ChatgptTokens;
	configurationUpdatedAt: Date;
}

export class ModelProviderNameConflict extends Data.TaggedError("ModelProviderNameConflict") {
	override get message() {
		return "A model provider with that name already exists";
	}
}

/**
 * Reading and writing a workspace's model providers and their models.
 *
 * Only `create` declares a failure: a name is unique per workspace, and the
 * route turns a clash into a conflict. Everything else answers with a value —
 * `undefined`, `false`, a count — and leaves a driver error as a defect.
 */
export interface ModelProviderStore {
	list(workspaceId: string): Effect.Effect<ModelProvider[], never, Database>;
	get(
		workspaceId: string,
		providerId: string,
	): Effect.Effect<ModelProvider | undefined, never, Database>;
	create(
		workspaceId: string,
		userId: string,
		input: NewModelProvider,
	): Effect.Effect<ModelProvider, ModelProviderNameConflict, Database>;
	update(
		workspaceId: string,
		providerId: string,
		input: ModelProviderUpdate,
	): Effect.Effect<ModelProvider | undefined, never, Database>;
	remove(workspaceId: string, providerId: string): Effect.Effect<boolean, never, Database>;
	/**
	 * Signs a ChatGPT provider in with `tokens`, or out with null. Like a new
	 * key, it leaves the provider inactive and untested until it is tried.
	 */
	saveChatgptSignIn(
		workspaceId: string,
		providerId: string,
		tokens: ChatgptTokens | null,
	): Effect.Effect<ModelProvider | undefined, never, Database>;
	/**
	 * Replaces a signed-in provider's tokens with what `renew` makes of them,
	 * holding its row locked meanwhile: a refresh token is good for one use, so
	 * two turns must not both spend it. Not a configuration change, so the
	 * provider's last test still stands. `undefined` if it is not signed in.
	 */
	renewChatgptTokens<E>(
		workspaceId: string,
		providerId: string,
		renew: (current: ChatgptTokens) => Effect.Effect<ChatgptTokens, E>,
	): Effect.Effect<ChatgptTokens | undefined, E, Database>;
	connection(
		workspaceId: string,
		providerId: string,
	): Effect.Effect<ProviderConnection | undefined, never, Database>;
	resolve(
		workspaceId: string,
		modelId: string,
	): Effect.Effect<ProviderConnection | undefined, never, Database>;
	/** recordTest applies a result only to the tested configuration, disabling it on failure. */
	recordTest(
		workspaceId: string,
		providerId: string,
		configurationUpdatedAt: Date,
		outcome: { error: string } | { activateOnSuccess: boolean },
	): Effect.Effect<void, never, Database>;
	addModels(
		workspaceId: string,
		providerId: string,
		models: Array<Omit<ProviderModel, "id" | "enabled" | "disabledCapabilities">>,
	): Effect.Effect<number, never, Database>;
	/**
	 * Records what a provider says it offers: new models are added, and a
	 * fetched one whose name, capabilities or context length it now reports
	 * differently is brought up to date. A model somebody added by hand keeps
	 * what they wrote, and one another provider in the workspace already lists
	 * is left to it.
	 */
	syncDiscovered(
		workspaceId: string,
		providerId: string,
		models: DiscoveredModel[],
	): Effect.Effect<{ added: number; updated: number }, never, Database>;
	setModelEnabled(
		workspaceId: string,
		providerId: string,
		ids: string[],
		enabled: boolean,
	): Effect.Effect<number, never, Database>;
	/**
	 * One model's switch, the capabilities switched off for agents, or, for a
	 * model added by hand, what it can do. The route keeps `capabilities` to
	 * hand-added models; a fetched one's are the provider's to say.
	 */
	updateModel(
		workspaceId: string,
		providerId: string,
		id: string,
		input: ProviderModelUpdate,
	): Effect.Effect<number, never, Database>;
	removeModel(
		workspaceId: string,
		providerId: string,
		id: string,
	): Effect.Effect<boolean, never, Database>;
	listEnabled(workspaceId: string): Effect.Effect<WorkspaceModelsResponse, never, Database>;
	isEnabled(workspaceId: string, modelId: string): Effect.Effect<boolean, never, Database>;
}

/** Seeds the starting providers into a workspace, with their starter models. */
function ensureSeeded(workspaceId: string): Effect.Effect<void, never, Database> {
	return Effect.gen(function* () {
		yield* query((db) =>
			db
				.insert(modelProvider)
				.values(
					seededPresets.map((id) => {
						const { name, baseUrl, apiFormat } = providerPreset(id);
						return { workspaceId, preset: id, name, baseUrl, apiFormat };
					}),
				)
				.onConflictDoNothing(),
		);
		yield* ensureStarterModels(workspaceId, seededPresets);
	});
}

/**
 * The catalog's starter models for the given presets, refreshed onto the
 * workspace's providers made from them. Discovery replaces these once a key is
 * in; until then they are what the picker has to offer.
 */
function ensureStarterModels(
	workspaceId: string,
	presets: readonly ProviderPresetId[],
): Effect.Effect<void, never, Database> {
	return Effect.gen(function* () {
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
		if (models.length > 0) {
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
		}
	});
}

function modelsFor(workspaceId: string, providerId: string) {
	return query((db) =>
		db
			.select()
			.from(providerModel)
			.where(
				and(eq(providerModel.workspaceId, workspaceId), eq(providerModel.providerId, providerId)),
			)
			.orderBy(asc(providerModel.displayName), asc(providerModel.modelId)),
	);
}

/** The store, over the cipher that seals and opens stored credentials. */
export function modelProviderStore(cipher: CredentialCipher): ModelProviderStore {
	const connection: ModelProviderStore["connection"] = (workspaceId, providerId) =>
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
			};
		});

	const create: ModelProviderStore["create"] = (workspaceId, userId, input) =>
		Effect.gen(function* () {
			yield* ensureSeeded(workspaceId);
			const values = providerValues(input, cipher);
			const inserted = yield* queryCatching(
				(db) =>
					db
						.insert(modelProvider)
						.values({ workspaceId, createdById: userId, ...values })
						.returning()
						.pipe(Effect.map(([row]) => row)),
				(failure) => (isUniqueViolation(failure) ? new ModelProviderNameConflict() : undefined),
			);
			if (!inserted) {
				return yield* Effect.die(new Error("Provider insert returned no row"));
			}
			if (inserted.preset) {
				yield* ensureStarterModels(workspaceId, [inserted.preset]);
			}
			return toProvider(inserted, yield* modelsFor(workspaceId, inserted.id));
		});

	const update: ModelProviderStore["update"] = (workspaceId, providerId, input) =>
		Effect.gen(function* () {
			const connectionChanged =
				input.baseUrl !== undefined ||
				input.apiFormat !== undefined ||
				input.apiKey !== undefined ||
				input.customHeaders !== undefined;
			const [row] = yield* query((db) =>
				db
					.update(modelProvider)
					.set({
						active: input.apiKey !== undefined ? false : input.active,
						baseUrl: input.baseUrl,
						apiFormat: input.apiFormat,
						apiKeyEncrypted: storedApiKey(input.apiKey, cipher),
						customHeadersEncrypted: input.customHeaders?.map(({ name, value }) => ({
							name,
							value: cipher.encrypt(value),
						})),
						lastTestedAt: connectionChanged ? null : undefined,
						lastTestError: connectionChanged ? null : undefined,
					})
					.where(and(eq(modelProvider.id, providerId), eq(modelProvider.workspaceId, workspaceId)))
					.returning(),
			);
			if (!row) return undefined;
			return toProvider(row, yield* modelsFor(workspaceId, providerId));
		});

	const saveChatgptSignIn: ModelProviderStore["saveChatgptSignIn"] = (
		workspaceId,
		providerId,
		tokens,
	) =>
		Effect.gen(function* () {
			const [row] = yield* query((db) =>
				db
					.update(modelProvider)
					.set({
						active: false,
						chatgptTokensEncrypted: tokens ? cipher.encrypt(JSON.stringify(tokens)) : null,
						lastTestedAt: null,
						lastTestError: null,
					})
					.where(and(eq(modelProvider.id, providerId), eq(modelProvider.workspaceId, workspaceId)))
					.returning(),
			);
			if (!row) return undefined;
			return toProvider(row, yield* modelsFor(workspaceId, providerId));
		});

	const renewChatgptTokens: ModelProviderStore["renewChatgptTokens"] = (
		workspaceId,
		providerId,
		renew,
	) =>
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
		);

	return {
		list: (workspaceId) =>
			Effect.gen(function* () {
				yield* ensureSeeded(workspaceId);
				const providers = yield* query((db) =>
					db
						.select()
						.from(modelProvider)
						.where(eq(modelProvider.workspaceId, workspaceId))
						.orderBy(asc(modelProvider.createdAt)),
				);
				const models =
					providers.length === 0
						? []
						: yield* query((db) =>
								db
									.select()
									.from(providerModel)
									.where(
										and(
											eq(providerModel.workspaceId, workspaceId),
											inArray(
												providerModel.providerId,
												providers.map(({ id }) => id),
											),
										),
									)
									.orderBy(asc(providerModel.displayName), asc(providerModel.modelId)),
							);
				return inListOrder(providers).map((provider) =>
					toProvider(
						provider,
						models.filter((model) => model.providerId === provider.id),
					),
				);
			}),
		get: (workspaceId, providerId) =>
			Effect.gen(function* () {
				const [row] = yield* query((db) =>
					db
						.select()
						.from(modelProvider)
						.where(
							and(eq(modelProvider.id, providerId), eq(modelProvider.workspaceId, workspaceId)),
						)
						.limit(1),
				);
				if (!row) return undefined;
				return toProvider(row, yield* modelsFor(workspaceId, providerId));
			}),
		create,
		update,
		saveChatgptSignIn,
		renewChatgptTokens,
		remove: (workspaceId, providerId) =>
			Effect.map(
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
				),
				(rows) => rows.length > 0,
			),
		connection,
		resolve: (workspaceId, modelId) =>
			Effect.gen(function* () {
				const [row] = yield* query((db) =>
					db
						.select({ providerId: modelProvider.id })
						.from(providerModel)
						.innerJoin(modelProvider, eq(modelProvider.id, providerModel.providerId))
						.where(
							and(
								eq(providerModel.workspaceId, workspaceId),
								eq(providerModel.modelId, modelId),
								eq(providerModel.enabled, true),
								eq(modelProvider.active, true),
								eq(modelProvider.workspaceId, workspaceId),
							),
						),
				);
				return row ? yield* connection(workspaceId, row.providerId) : undefined;
			}),
		recordTest: (workspaceId, providerId, configurationUpdatedAt, outcome) =>
			Effect.asVoid(
				query((db) =>
					db
						.update(modelProvider)
						.set({
							lastTestedAt: new Date(),
							lastTestError: "error" in outcome ? outcome.error : null,
							active: "error" in outcome ? false : outcome.activateOnSuccess ? true : undefined,
						})
						.where(
							and(
								eq(modelProvider.id, providerId),
								eq(modelProvider.workspaceId, workspaceId),
								// Postgres stamps microseconds on insert, drizzle milliseconds on
								// update, and a Date has only milliseconds: compare at that.
								sql`date_trunc('milliseconds', ${modelProvider.updatedAt}) = ${configurationUpdatedAt}`,
							),
						),
				),
			),
		addModels: (workspaceId, providerId, models) =>
			models.length === 0
				? Effect.succeed(0)
				: Effect.map(
						query((db) =>
							db
								.insert(providerModel)
								.values(
									models.map((model) => ({
										...model,
										workspaceId,
										providerId,
										enabled: false,
									})),
								)
								.onConflictDoNothing()
								.returning({ id: providerModel.id }),
						),
						(rows) => rows.length,
					),
		syncDiscovered: (workspaceId, providerId, models) =>
			models.length === 0
				? Effect.succeed({ added: 0, updated: 0 })
				: Effect.gen(function* () {
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
						const offered = models.filter(({ modelId }) => !claimed.has(modelId));
						if (offered.length === 0) return { added: 0, updated: 0 };
						const rows = yield* query((db) =>
							db
								.insert(providerModel)
								.values(
									offered.map((model) => ({
										...model,
										workspaceId,
										providerId,
										enabled: false,
										source: "fetched" as const,
									})),
								)
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
		setModelEnabled: (workspaceId, providerId, ids, enabled) =>
			ids.length === 0
				? Effect.succeed(0)
				: Effect.map(
						query((db) =>
							db
								.update(providerModel)
								.set({ enabled })
								.where(
									and(
										eq(providerModel.workspaceId, workspaceId),
										eq(providerModel.providerId, providerId),
										inArray(providerModel.id, ids),
									),
								)
								.returning({ id: providerModel.id }),
						),
						(rows) => rows.length,
					),
		updateModel: (workspaceId, providerId, id, input) =>
			Effect.map(
				query((db) =>
					db
						.update(providerModel)
						.set({
							enabled: input.enabled,
							capabilities: input.capabilities,
							disabledCapabilities: input.disabledCapabilities,
						})
						.where(
							and(
								eq(providerModel.workspaceId, workspaceId),
								eq(providerModel.providerId, providerId),
								eq(providerModel.id, id),
							),
						)
						.returning({ id: providerModel.id }),
				),
				(rows) => rows.length,
			),
		removeModel: (workspaceId, providerId, id) =>
			Effect.map(
				query((db) =>
					db
						.delete(providerModel)
						.where(
							and(
								eq(providerModel.workspaceId, workspaceId),
								eq(providerModel.providerId, providerId),
								eq(providerModel.id, id),
								eq(providerModel.source, "manual"),
							),
						)
						.returning({ id: providerModel.id }),
				),
				(rows) => rows.length > 0,
			),
		listEnabled: (workspaceId) =>
			Effect.gen(function* () {
				const rows = yield* query((db) =>
					db
						.select({ model: providerModel, provider: modelProvider })
						.from(providerModel)
						.innerJoin(modelProvider, eq(modelProvider.id, providerModel.providerId))
						.where(
							and(
								eq(providerModel.workspaceId, workspaceId),
								eq(providerModel.enabled, true),
								eq(modelProvider.active, true),
								eq(modelProvider.workspaceId, workspaceId),
							),
						),
				);
				return {
					models: rows
						.filter(({ model }) => !effectiveCapabilities(model).includes("embeddings"))
						.map(({ model, provider }) => ({
							providerId: provider.id,
							providerName: provider.name,
							providerPreset: provider.preset,
							providerActive: provider.active,
							modelId: model.modelId,
							displayName: model.displayName,
						})),
				};
			}),
		isEnabled: (workspaceId, modelId) =>
			Effect.gen(function* () {
				const [row] = yield* query((db) =>
					db
						.select({ id: providerModel.id })
						.from(providerModel)
						.innerJoin(modelProvider, eq(modelProvider.id, providerModel.providerId))
						.where(
							and(
								eq(providerModel.workspaceId, workspaceId),
								eq(providerModel.modelId, modelId),
								eq(providerModel.enabled, true),
								eq(modelProvider.active, true),
								eq(modelProvider.workspaceId, workspaceId),
							),
						),
				);
				return Boolean(row);
			}),
	};
}

/**
 * The row a new provider is inserted as. From a preset, the catalog supplies
 * the name, address and protocol and the caller only the key, and for a local
 * preset perhaps the address; a custom endpoint is described in full.
 */
function providerValues(input: NewModelProvider, cipher: CredentialCipher) {
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
function storedApiKey(apiKey: ModelProviderUpdate["apiKey"], cipher: CredentialCipher) {
	if (apiKey === undefined) return undefined;
	return apiKey === null ? null : cipher.encrypt(apiKey);
}

/**
 * The defaults first, in the catalog's order, then the rest as they were
 * added: a default seeded into an older workspace is still one of the defaults.
 */
function inListOrder<Row extends Pick<typeof modelProvider.$inferSelect, "preset">>(
	rows: Row[],
): Row[] {
	const rank = (row: Row) => {
		const seeded = row.preset ? seededPresets.indexOf(row.preset) : -1;
		return seeded === -1 ? seededPresets.length : seeded;
	};
	return rows.toSorted((a, b) => rank(a) - rank(b));
}

/** A provider that cannot be used yet: it wants a key, or a sign-in, it has not had. */
function lacksCredential(
	row: Pick<
		typeof modelProvider.$inferSelect,
		"preset" | "apiKeyEncrypted" | "chatgptTokensEncrypted"
	>,
): boolean {
	if (presetSignsIn(row.preset)) return !row.chatgptTokensEncrypted;
	return presetRequiresApiKey(row.preset) && !row.apiKeyEncrypted;
}

function openChatgptTokens(sealed: string, cipher: CredentialCipher): ChatgptTokens {
	return Schema.decodeUnknownSync(ChatgptTokens)(JSON.parse(cipher.decrypt(sealed)));
}

function toProvider(
	row: typeof modelProvider.$inferSelect,
	models: Array<typeof providerModel.$inferSelect>,
): ModelProvider {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		preset: row.preset,
		name: row.name,
		baseUrl: row.baseUrl,
		apiFormat: row.apiFormat,
		active: row.active,
		status: lacksCredential(row)
			? presetSignsIn(row.preset)
				? "signed_out"
				: "missing_key"
			: !row.lastTestedAt
				? "untested"
				: row.lastTestError
					? "error"
					: "connected",
		hasApiKey: Boolean(row.apiKeyEncrypted),
		apiKeyHint: row.apiKeyEncrypted ? "********" : null,
		signedIn: Boolean(row.chatgptTokensEncrypted),
		customHeaders: row.customHeadersEncrypted.map(({ name }) => ({
			name,
			valueHint: "********",
		})),
		modelCount: models.length,
		enabledModelCount: models.filter(({ enabled }) => enabled).length,
		lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
		lastTestError: row.lastTestError,
		models: models.map((model) => ({
			id: model.id,
			modelId: model.modelId,
			displayName: model.displayName,
			capabilities: model.capabilities,
			disabledCapabilities: model.disabledCapabilities,
			contextLength: model.contextLength,
			enabled: model.enabled,
			source: model.source,
		})),
	};
}

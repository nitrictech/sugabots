export { ModelNotEnabled } from "@sugabots/contracts/errors/providers";
export * as ModelProviderStore from "./model-provider-store.ts";

import type {
	BuiltInProviderId,
	ModelProviderUpdate,
	NewModelProvider,
	ProviderApiFormat,
	ProviderModel,
	ProviderModelCapability,
	ProviderModelUpdate,
} from "@sugabots/contracts";
import { providerBuiltIn, providerLacksCredential, seededBuiltIns } from "@sugabots/contracts";
import { ModelNotEnabled, ModelProviderNameConflict } from "@sugabots/contracts/errors/providers";
import { DisplayName, type UserText } from "@sugabots/errors";
import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { Context, DateTime, Duration, Effect, Layer, Schema } from "effect";
import { query, queryCatching, serviceOperations, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import {
	type ModelProviderRow,
	modelProvider,
	providerModel,
	workspaceDefaultModel,
} from "../../database/schema.ts";
import { Secrets } from "../../secrets/secrets.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { inWorkspaceUnderMembershipLock } from "../../workspaces/membership/member-reads.ts";
import { changesAddress, stillConfiguredAs } from "../tested-configuration.ts";
import type { DiscoveredModel } from "./dialects/index.ts";
import { OAuthTokens } from "./sign-in/sign-in.ts";

/**
 * The only writer of `model_provider`, `provider_model` and
 * `workspace_default_model`: a workspace's model providers, their sealed
 * credentials, the models each offers, and which of those is the default.
 *
 * A provider is switched on only by a successful test of its current
 * configuration, through `recordTest`; `update` can only switch it off, and a
 * new key or a new address switches it off until it has been tried. A new
 * address also takes away the key, headers and sign-in the provider held,
 * other than a key or headers given with it, and a new key takes the place of
 * a subscription sign-in.
 */
export interface Interface {
	/**
	 * Gives a new workspace the built-in providers and their starter models.
	 */
	readonly seedBuiltInProviders: (workspaceId: string) => Effect.Effect<void>;
	readonly create: (
		workspaceId: string,
		input: { createdById: string; provider: NewModelProvider },
	) => Effect.Effect<ModelProviderRow, ModelProviderNameConflict>;
	/**
	 * Applies `changes` made by `changedById`, who becomes who connected it when
	 * the change connects it: a new key, or switching on one that holds no key or
	 * sign-in.
	 */
	readonly update: (
		workspaceId: string,
		providerId: string,
		changes: ModelProviderUpdate,
		changedById: string,
	) => Effect.Effect<ModelProviderRow | undefined>;
	/** Only a custom provider goes; `false` for a seeded one or one that is not there. */
	readonly remove: (workspaceId: string, providerId: string) => Effect.Effect<boolean>;
	/**
	 * Signs a subscription provider in, recording who did, or out with null. Like
	 * a new key, it leaves the provider inactive and untested until it is tried.
	 * Answers whether it was saved: a sign-in by someone no longer in the
	 * workspace isn't, and leaves the provider as it was. The sign-in is
	 * recorded under the workspace's membership lock, so removing its signer,
	 * or their leaving, either sees it or comes first.
	 */
	readonly saveOAuthTokens: (
		workspaceId: string,
		providerId: string,
		signIn: { tokens: OAuthTokens; signedInById: string } | null,
	) => Effect.Effect<boolean>;
	/**
	 * A signed-in provider's tokens, refreshed first when `renewal` finds them
	 * stale, or `undefined` if it is not signed in. A refresh token is good for
	 * one use, so one process at a time refreshes, under a claim it commits
	 * before calling the sign-in service and holds no transaction across;
	 * another waits for it, for at most the claim's lease, and then makes do
	 * with what it has. The refreshed tokens are saved unless the provider was
	 * signed in again meanwhile. Not a configuration change, so the provider's
	 * last test still stands.
	 */
	readonly renewOAuthTokens: <E>(
		workspaceId: string,
		providerId: string,
		renewal: {
			readonly isStale: (current: OAuthTokens) => Effect.Effect<boolean>;
			readonly refresh: (current: OAuthTokens) => Effect.Effect<OAuthTokens, E>;
		},
	) => Effect.Effect<OAuthTokens | undefined, E>;
	/**
	 * How to reach the provider with `candidate` in place of its key or
	 * sign-in, and the other changes given with a key, without storing any of
	 * it, so the candidate can be tried before it replaces what works.
	 * `configurationUpdatedAt` is the configuration it was built on, which
	 * {@link Interface.replaceCredential} checks is still the provider's.
	 */
	readonly candidateAccess: (
		workspaceId: string,
		providerId: string,
		candidate: CandidateCredential,
	) => Effect.Effect<ProviderAccess | undefined>;
	/**
	 * Puts `candidate`, which has answered with `models`, in place of the
	 * provider's key or sign-in, as one change: who connected it, whether it is
	 * on, its test and its models. Run under the held-models lock. Changes
	 * nothing, and answers why, when the configuration `candidateAccess` built on
	 * has changed since (`reconfigured`), or the member signing in has left the
	 * workspace (`signerGone`, checked under its membership lock).
	 */
	readonly replaceCredential: (
		workspaceId: string,
		providerId: string,
		replacement: {
			candidate: CandidateCredential;
			builtOn: Date;
			changedById: string;
			active: boolean;
			models: DiscoveredModel[];
		},
	) => Effect.Effect<ModelProviderRow | "reconfigured" | "signerGone">;
	/**
	 * Records the models the configuration last updated at `testedAt` listed,
	 * and its successful test, as one change, switching it on when
	 * `activateOnSuccess` asks; nothing, and `undefined`, once it has been
	 * reconfigured since, so models one configuration listed are never
	 * recorded against another.
	 */
	readonly recordDiscovery: (
		workspaceId: string,
		providerId: string,
		testedAt: Date,
		models: DiscoveredModel[],
		activateOnSuccess: boolean,
	) => Effect.Effect<{ added: number; updated: number } | undefined>;
	/**
	 * Records how a test of the configuration last updated at `testedAt` went,
	 * unless the provider has been reconfigured since. A success switches it on
	 * when `activateOnSuccess` asks; a failure leaves it as it was.
	 */
	readonly recordTest: (
		workspaceId: string,
		providerId: string,
		testedAt: Date,
		outcome: { error: UserText } | { activateOnSuccess: boolean },
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
	/**
	 * One model's switch, the capabilities switched off for bots, or, for a
	 * model added by hand, what it can do; a fetched model's capabilities are
	 * the provider's to say, so `capabilities` changes only a manual one.
	 */
	readonly updateModel: (
		workspaceId: string,
		providerId: string,
		modelId: string,
		changes: ProviderModelUpdate,
	) => Effect.Effect<number>;
	/** How to reach a provider, or nothing while it lacks the key or sign-in its built-in provider needs. */
	readonly access: (
		workspaceId: string,
		providerId: string,
	) => Effect.Effect<ProviderAccess | undefined>;
	/**
	 * The provider that offers `modelId` while the workspace offers it, with the
	 * names members know both by, and how to reach it if it has the key or
	 * sign-in it needs.
	 */
	readonly resolve: (
		workspaceId: string,
		modelId: string,
	) => Effect.Effect<ResolvedModel | undefined>;
	/**
	 * Whether the workspace offers a model: it is switched on, at a provider that
	 * is. The one rule for what a bot may run on.
	 */
	readonly isEnabled: (workspaceId: string, modelId: string) => Effect.Effect<boolean>;
	/** {@link Interface.isEnabled}, as a refusal. */
	readonly requireEnabled: (
		workspaceId: string,
		modelId: string,
	) => Effect.Effect<void, ModelNotEnabled>;
	/** The model the workspace's new bots start on, or nothing until it first offers one. */
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
	"@sugabots/core/ModelProviderStore",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ModelProviderStore");
	const cipher = yield* Secrets.Service;

	/**
	 * The starter models Sugabots ships for the given built-in providers, refreshed onto the
	 * workspace's providers made from them. Discovery replaces these once a key
	 * is in; until then they are what the picker has to offer.
	 */
	const ensureStarterModels = (workspaceId: string, builtIns: readonly BuiltInProviderId[]) =>
		Effect.gen(function* () {
			const withModels = builtIns.filter((id) => providerBuiltIn(id).models.length > 0);
			if (withModels.length === 0) return;
			const providers = yield* query((db) =>
				db
					.select({ id: modelProvider.id, builtIn: modelProvider.builtIn })
					.from(modelProvider)
					.where(
						and(
							eq(modelProvider.workspaceId, workspaceId),
							inArray(modelProvider.builtIn, withModels),
						),
					),
			);
			const models = providers.flatMap((provider) =>
				(provider.builtIn ? providerBuiltIn(provider.builtIn).models : []).map((model) => ({
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

	const providerAccess = (workspaceId: string, providerId: string) =>
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
				builtIn: row.builtIn,
				baseUrl: row.baseUrl,
				apiFormat: row.apiFormat,
				apiKey: row.apiKeyEncrypted ? cipher.decrypt(row.apiKeyEncrypted) : undefined,
				oauthTokens: row.oauthTokensEncrypted
					? openOAuthTokens(row.oauthTokensEncrypted, cipher)
					: undefined,
				configurationUpdatedAt: row.updatedAt,
				headers: Object.fromEntries(
					row.customHeadersEncrypted.map(({ name, value }) => [name, cipher.decrypt(value)]),
				),
			} satisfies ProviderAccess;
		});

	/** What `syncDiscovered` says: new models added, fetched ones brought up to date. */
	const syncModels = (workspaceId: string, providerId: string, models: DiscoveredModel[]) =>
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
		seedBuiltInProviders: (workspaceId) =>
			operation(
				"seedBuiltInProviders",
				Effect.gen(function* () {
					const providers = seededBuiltIns.map((id) => {
						const { name, baseUrl, apiFormat } = providerBuiltIn(id);
						return { workspaceId, builtIn: id, name, baseUrl, apiFormat };
					});
					yield* query((db) => db.insert(modelProvider).values(providers).onConflictDoNothing());
					yield* ensureStarterModels(workspaceId, seededBuiltIns);
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
								.values({
									workspaceId,
									createdById,
									connectedById: createdById,
									...providerValues(provider, cipher),
								})
								.returning(),
						(failure) => (isUniqueViolation(failure) ? new ModelProviderNameConflict() : undefined),
					);
					if (!inserted) {
						return yield* Effect.die(new Error("Provider insert returned no row"));
					}
					if (inserted.builtIn) {
						yield* ensureStarterModels(workspaceId, [inserted.builtIn]);
					}
					return inserted;
				}),
			),

		update: (workspaceId, providerId, changes, changedById) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						const inProvider = and(
							eq(modelProvider.id, providerId),
							eq(modelProvider.workspaceId, workspaceId),
						);
						const [current] = yield* query((db) =>
							db
								.select({ baseUrl: modelProvider.baseUrl })
								.from(modelProvider)
								.where(inProvider)
								.for("update"),
						);
						if (!current) return undefined;
						const moved = changesAddress(changes.baseUrl, current.baseUrl);
						const losesSignIn = moved || Boolean(changes.apiKey);
						const configurationChanged =
							changes.baseUrl !== undefined ||
							changes.apiFormat !== undefined ||
							changes.apiKey !== undefined ||
							changes.customHeaders !== undefined;
						const values = {
							// A new key or a new address is on only once a test of it has succeeded.
							active: changes.apiKey !== undefined || moved ? false : changes.active,
							connectedById: connectedByAfter(changes, changedById),
							baseUrl: changes.baseUrl,
							apiFormat: changes.apiFormat,
							apiKeyEncrypted: storedApiKey(changes.apiKey, moved, cipher),
							customHeadersEncrypted:
								changes.customHeaders?.map(({ name, value }) => ({
									name,
									value: cipher.encrypt(value),
								})) ?? (moved ? [] : undefined),
							oauthTokensEncrypted: losesSignIn ? null : undefined,
							signedInById: losesSignIn ? null : undefined,
							lastTestedAt: configurationChanged ? null : undefined,
							lastTestError: configurationChanged ? null : undefined,
						};
						// An UPDATE must set something, and a change may name nothing this writes.
						const [row] = Object.values(values).some((value) => value !== undefined)
							? yield* query((db) =>
									db.update(modelProvider).set(values).where(inProvider).returning(),
								)
							: yield* query((db) => db.select().from(modelProvider).where(inProvider));
						return row;
					}),
				),
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
									isNull(modelProvider.builtIn),
									notInArray(modelProvider.builtIn, [...seededBuiltIns]),
								),
							),
						)
						.returning({ id: modelProvider.id }),
				).pipe(Effect.map((rows) => rows.length > 0)),
			),

		saveOAuthTokens: (workspaceId, providerId, signIn) =>
			operation(
				"saveOAuthTokens",
				transaction(
					Effect.gen(function* () {
						if (
							signIn &&
							!(yield* inWorkspaceUnderMembershipLock(workspaceId, signIn.signedInById))
						) {
							return false;
						}
						yield* query((db) =>
							db
								.update(modelProvider)
								.set(
									signIn
										? {
												active: false,
												oauthTokensEncrypted: cipher.encrypt(JSON.stringify(signIn.tokens)),
												oauthRefreshId: null,
												oauthRefreshUntil: null,
												signedInById: signIn.signedInById,
												connectedById: signIn.signedInById,
												lastTestedAt: null,
												lastTestError: null,
											}
										: SIGNED_OUT,
								)
								.where(
									and(eq(modelProvider.id, providerId), eq(modelProvider.workspaceId, workspaceId)),
								),
						);
						return true;
					}),
				),
			),

		renewOAuthTokens: (workspaceId, providerId, { isStale, refresh }) =>
			operation(
				"renewOAuthTokens",
				Effect.gen(function* () {
					const inProvider = and(
						eq(modelProvider.id, providerId),
						eq(modelProvider.workspaceId, workspaceId),
					);
					// Kept as it was, so a test of the configuration still records against it.
					const sameConfiguration = { updatedAt: sql<Date>`${modelProvider.updatedAt}` };
					for (let waited = 0; ; waited++) {
						const [row] = yield* query((db) =>
							db
								.select({ sealed: modelProvider.oauthTokensEncrypted })
								.from(modelProvider)
								.where(inProvider),
						);
						if (!row?.sealed) return undefined;
						const sealed = row.sealed;
						const current = openOAuthTokens(sealed, cipher);
						if (!(yield* isStale(current))) return current;
						const [claim] = yield* query((db) =>
							db
								.update(modelProvider)
								.set({
									oauthRefreshId: sql`uuidv7()`,
									oauthRefreshUntil: sql`clock_timestamp() + ${Duration.toMillis(REFRESH_CLAIM)} * interval '1 millisecond'`,
									...sameConfiguration,
								})
								.where(
									and(
										inProvider,
										eq(modelProvider.oauthTokensEncrypted, sealed),
										sql`coalesce(${modelProvider.oauthRefreshUntil}, '-infinity') <= clock_timestamp()`,
									),
								)
								.returning({ id: modelProvider.oauthRefreshId }),
						);
						if (!claim?.id) {
							// Another process is refreshing them: its tokens are the ones to use.
							if (waited * Duration.toMillis(REFRESH_WAIT) >= Duration.toMillis(REFRESH_CLAIM)) {
								return current;
							}
							yield* Effect.sleep(REFRESH_WAIT);
							continue;
						}
						const claimId = claim.id;
						const refreshed = yield* refresh(current).pipe(
							Effect.onError(() =>
								query((db) =>
									db
										.update(modelProvider)
										.set({ oauthRefreshId: null, oauthRefreshUntil: null, ...sameConfiguration })
										.where(and(inProvider, eq(modelProvider.oauthRefreshId, claimId))),
								).pipe(Effect.ignore),
							),
						);
						// Saved over the tokens it refreshed, even once its claim has run
						// out, since they no longer refresh; not over a new sign-in.
						yield* query((db) =>
							db
								.update(modelProvider)
								.set({
									oauthTokensEncrypted: cipher.encrypt(JSON.stringify(refreshed)),
									oauthRefreshId: null,
									oauthRefreshUntil: null,
									...sameConfiguration,
								})
								.where(
									and(
										inProvider,
										or(
											eq(modelProvider.oauthRefreshId, claimId),
											eq(modelProvider.oauthTokensEncrypted, sealed),
										),
									),
								),
						);
						return refreshed;
					}
				}),
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
								active:
									"activateOnSuccess" in outcome && outcome.activateOnSuccess ? true : undefined,
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
			operation("syncDiscovered", syncModels(workspaceId, providerId, models)),

		candidateAccess: (workspaceId, providerId, candidate) =>
			operation(
				"candidateAccess",
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.select()
							.from(modelProvider)
							.where(
								and(eq(modelProvider.id, providerId), eq(modelProvider.workspaceId, workspaceId)),
							),
					);
					if (!row) return undefined;
					const stored = Object.fromEntries(
						row.customHeadersEncrypted.map(({ name, value }) => [name, cipher.decrypt(value)]),
					);
					if ("tokens" in candidate) {
						return {
							providerId: row.id,
							builtIn: row.builtIn,
							baseUrl: row.baseUrl,
							apiFormat: row.apiFormat,
							apiKey: row.apiKeyEncrypted ? cipher.decrypt(row.apiKeyEncrypted) : undefined,
							oauthTokens: candidate.tokens,
							configurationUpdatedAt: row.updatedAt,
							headers: stored,
						} satisfies ProviderAccess;
					}
					return {
						providerId: row.id,
						builtIn: row.builtIn,
						baseUrl: row.baseUrl,
						apiFormat: candidate.apiFormat ?? row.apiFormat,
						apiKey: candidate.apiKey,
						configurationUpdatedAt: row.updatedAt,
						headers: candidate.customHeaders
							? Object.fromEntries(candidate.customHeaders.map(({ name, value }) => [name, value]))
							: stored,
					} satisfies ProviderAccess;
				}),
			),

		replaceCredential: (
			workspaceId,
			providerId,
			{ candidate, builtOn, changedById, active, models },
		) =>
			operation(
				"replaceCredential",
				transaction(
					Effect.gen(function* () {
						if (
							"tokens" in candidate &&
							!(yield* inWorkspaceUnderMembershipLock(workspaceId, candidate.signedInById))
						) {
							return "signerGone" as const;
						}
						const inProvider = and(
							eq(modelProvider.id, providerId),
							eq(modelProvider.workspaceId, workspaceId),
						);
						const [unchanged] = yield* query((db) =>
							db
								.select({ id: modelProvider.id })
								.from(modelProvider)
								.where(and(inProvider, stillConfiguredAs(modelProvider.updatedAt, builtOn)))
								.for("update"),
						);
						if (!unchanged) return "reconfigured" as const;
						const now = yield* DateTime.nowAsDate;
						const credential =
							"tokens" in candidate
								? {
										oauthTokensEncrypted: cipher.encrypt(JSON.stringify(candidate.tokens)),
										oauthRefreshId: null,
										oauthRefreshUntil: null,
										signedInById: candidate.signedInById,
										connectedById: candidate.signedInById,
									}
								: {
										apiKeyEncrypted: cipher.encrypt(candidate.apiKey),
										apiFormat: candidate.apiFormat,
										customHeadersEncrypted: candidate.customHeaders?.map(({ name, value }) => ({
											name,
											value: cipher.encrypt(value),
										})),
										oauthTokensEncrypted: null,
										signedInById: null,
										connectedById: changedById,
									};
						const [row] = yield* query((db) =>
							db
								.update(modelProvider)
								.set({ ...credential, active, lastTestedAt: now, lastTestError: null })
								.where(inProvider)
								.returning(),
						);
						yield* syncModels(workspaceId, providerId, models);
						return row ?? ("reconfigured" as const);
					}),
				),
			),

		recordDiscovery: (workspaceId, providerId, testedAt, models, activateOnSuccess) =>
			operation(
				"recordDiscovery",
				transaction(
					Effect.gen(function* () {
						const inProvider = and(
							eq(modelProvider.id, providerId),
							eq(modelProvider.workspaceId, workspaceId),
							stillConfiguredAs(modelProvider.updatedAt, testedAt),
						);
						const [unchanged] = yield* query((db) =>
							db
								.select({ id: modelProvider.id })
								.from(modelProvider)
								.where(inProvider)
								.for("update"),
						);
						if (!unchanged) return undefined;
						const synced = yield* syncModels(workspaceId, providerId, models);
						const now = yield* DateTime.nowAsDate;
						yield* query((db) =>
							db
								.update(modelProvider)
								.set({
									lastTestedAt: now,
									lastTestError: null,
									active: activateOnSuccess ? true : undefined,
								})
								.where(inProvider),
						);
						return synced;
					}),
				),
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

		access: (workspaceId, providerId) =>
			operation("access", providerAccess(workspaceId, providerId)),

		resolve: (workspaceId, modelId) =>
			operation(
				"resolve",
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.select({
								providerId: modelProvider.id,
								providerName: modelProvider.name,
								modelName: providerModel.displayName,
								capabilities: providerModel.capabilities,
								disabledCapabilities: providerModel.disabledCapabilities,
							})
							.from(providerModel)
							.innerJoin(modelProvider, eq(modelProvider.id, providerModel.providerId))
							.where(and(offeredIn(workspaceId), eq(providerModel.modelId, modelId))),
					);
					if (!row) return undefined;
					return {
						access: yield* providerAccess(workspaceId, row.providerId),
						providerName: DisplayName.fromRecord(row.providerName),
						modelName: DisplayName.fromRecord(row.modelName ?? modelId),
						capabilities: capabilitiesOn(row),
					};
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

export const layer = processLayer(Layer.effect(Service, make));

/** How long a process has a refresh of a provider's tokens to itself: more than the sign-in service is given to answer. */
const REFRESH_CLAIM = Duration.seconds(30);

/** How often a process waiting for another's refresh looks for its tokens. */
const REFRESH_WAIT = Duration.millis(250);

/**
 * A key, with the headers and protocol given with it, or a member's
 * subscription sign-in: what is tried in place of a provider's credential.
 */
export type CandidateCredential =
	| {
			apiKey: string;
			apiFormat?: ProviderApiFormat;
			customHeaders?: ReadonlyArray<{ name: string; value: string }>;
	  }
	| { tokens: OAuthTokens; signedInById: string };

/** The provider that offers a model, and the names members know both by. */
export interface ResolvedModel {
	/** Nothing while the provider lacks the key or sign-in its built-in provider needs. */
	access: ProviderAccess | undefined;
	providerName: DisplayName;
	modelName: DisplayName;
	capabilities: readonly ProviderModelCapability[];
}

/** How to reach a provider: where, in which protocol, and with which credentials. */
export interface ProviderAccess {
	providerId: string;
	builtIn: BuiltInProviderId | null;
	baseUrl: string;
	apiFormat: ProviderApiFormat;
	apiKey?: string;
	headers: Record<string, string>;
	/**
	 * A signed-in subscription provider's tokens, which stand in for its key.
	 * Use the provider access through `withSignInAccess`, which puts a live token in
	 * `apiKey`.
	 */
	oauthTokens?: OAuthTokens;
	/** The provider's `updatedAt`, so a test's result is recorded against what it tried. */
	configurationUpdatedAt: Date;
}

/** The model the workspace's new bots start on, or nothing until it first offers one. */
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
 * An embedding model cannot hold a chat, so no bot runs on one. It
 * is one while it has the capability and an admin has not switched it off.
 */
const notEmbedding = sql`not (${providerModel.capabilities} @> '["embeddings"]' and not ${providerModel.disabledCapabilities} @> '["embeddings"]')`;

/**
 * The row a new provider is inserted as. From a built-in provider, Sugabots supplies
 * the name, address and protocol and the caller only the key, and for a local
 * built-in provider perhaps the address; a custom model provider is described in full.
 */
function providerValues(input: NewModelProvider, cipher: Secrets.Interface) {
	const apiKeyEncrypted = input.apiKey ? cipher.encrypt(input.apiKey) : undefined;
	if ("builtIn" in input) {
		const { id, name, baseUrl, apiFormat } = providerBuiltIn(input.builtIn);
		return {
			builtIn: id,
			name,
			baseUrl: input.baseUrl ?? baseUrl,
			apiFormat,
			apiKeyEncrypted,
			customHeadersEncrypted: [],
		};
	}
	return {
		builtIn: null,
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

/** What signing a subscription provider out leaves: switched off and untested until it is signed in and tried again. */
const SIGNED_OUT = {
	active: false,
	oauthTokensEncrypted: null,
	oauthRefreshId: null,
	oauthRefreshUntil: null,
	signedInById: null,
	lastTestedAt: null,
	lastTestError: null,
} satisfies Partial<ModelProviderRow>;

/**
 * What an update by `changedById` writes to `connected_by_id`. A new key is
 * theirs. Switching on connects only one that holds no key or sign-in, and was
 * off; one already connected keeps whoever connected it. Any change to the key
 * switches the provider off, so switching on as the key is taken away connects
 * nothing.
 */
function connectedByAfter(changes: ModelProviderUpdate, changedById: string) {
	if (changes.apiKey) return changedById;
	if (changes.active !== true) return undefined;
	return sql<string>`case when ${modelProvider.active} or ${modelProvider.apiKeyEncrypted} is not null or ${modelProvider.oauthTokensEncrypted} is not null then ${modelProvider.connectedById} else ${changedById}::uuid end`;
}

/**
 * What an update writes to the key column: absent leaves it, unless the
 * address `moved`, and null clears it.
 */
function storedApiKey(
	apiKey: ModelProviderUpdate["apiKey"],
	moved: boolean,
	cipher: Secrets.Interface,
) {
	if (apiKey === undefined) return moved ? null : undefined;
	return apiKey === null ? null : cipher.encrypt(apiKey);
}

/** `providerLacksCredential` for a stored row, which holds the key and sign-in rather than says whether it has them. */
function lacksCredential(
	row: Pick<ModelProviderRow, "builtIn" | "apiKeyEncrypted" | "oauthTokensEncrypted">,
): boolean {
	return providerLacksCredential({
		builtIn: row.builtIn,
		hasApiKey: row.apiKeyEncrypted !== null,
		signedIn: row.oauthTokensEncrypted !== null,
	});
}

function openOAuthTokens(sealed: string, cipher: Secrets.Interface): OAuthTokens {
	return Schema.decodeUnknownSync(OAuthTokens)(JSON.parse(cipher.decrypt(sealed)));
}

/** The model's capabilities, less those someone switched off. */
export function capabilitiesOn(model: {
	capabilities: readonly ProviderModelCapability[];
	disabledCapabilities: readonly ProviderModelCapability[];
}) {
	return model.capabilities.filter(
		(capability) => !model.disabledCapabilities.includes(capability),
	);
}

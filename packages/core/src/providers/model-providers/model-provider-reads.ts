import type { ModelProvider, WorkspaceModelsResponse } from "@sugabots/contracts";
import { presetSignsIn, seededPresets } from "@sugabots/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { type Executor, query } from "../../database/database.ts";
import {
	type ModelProviderRow,
	modelProvider,
	type ProviderModelRow,
	providerModel,
	user,
} from "../../database/schema.ts";
import { configurationStatus } from "../tested-configuration.ts";
import { defaultModelOf, lacksCredential, offeredIn } from "./model-provider-repository.ts";

/**
 * Every model provider in the workspace, each with its models: the defaults
 * first, in the catalog's order, then the rest oldest first.
 */
export const providersIn = (workspaceId: string) =>
	Effect.gen(function* () {
		const providers = yield* query((db) =>
			withConnectedBy(db)
				.where(eq(modelProvider.workspaceId, workspaceId))
				.orderBy(asc(modelProvider.createdAt)),
		);
		if (providers.length === 0) return [];
		const models = yield* query((db) =>
			db
				.select()
				.from(providerModel)
				.where(
					and(
						eq(providerModel.workspaceId, workspaceId),
						inArray(
							providerModel.providerId,
							providers.map(({ provider }) => provider.id),
						),
					),
				)
				.orderBy(asc(providerModel.displayName), asc(providerModel.modelId)),
		);
		return inListOrder(providers).map(({ provider, connectedBy }) =>
			toProvider(
				provider,
				connectedBy,
				models.filter((model) => model.providerId === provider.id),
			),
		);
	});

/** One of the workspace's model providers, with its models, or nothing. */
export const providerIn = (workspaceId: string, providerId: string) =>
	Effect.gen(function* () {
		const [row] = yield* query((db) =>
			withConnectedBy(db)
				.where(and(eq(modelProvider.id, providerId), eq(modelProvider.workspaceId, workspaceId)))
				.limit(1),
		);
		if (!row) return undefined;
		const models = yield* query((db) =>
			db
				.select()
				.from(providerModel)
				.where(
					and(eq(providerModel.workspaceId, workspaceId), eq(providerModel.providerId, providerId)),
				)
				.orderBy(asc(providerModel.displayName), asc(providerModel.modelId)),
		);
		return toProvider(row.provider, row.connectedBy, models);
	});

/**
 * The models the workspace offers for agents to run on, and its default, which
 * it does not offer while a failed test has that model's provider off.
 */
export const offeredModels = (workspaceId: string) =>
	Effect.all([
		query((db) =>
			db
				.select({ model: providerModel, provider: modelProvider })
				.from(providerModel)
				.innerJoin(modelProvider, eq(modelProvider.id, providerModel.providerId))
				.where(offeredIn(workspaceId)),
		),
		defaultModelOf(workspaceId),
	]).pipe(
		Effect.map(
			([rows, defaultModel]): WorkspaceModelsResponse => ({
				models: rows.map(({ model, provider }) => ({
					providerId: provider.id,
					providerName: provider.name,
					providerPreset: provider.preset,
					providerActive: provider.active,
					modelId: model.modelId,
					displayName: model.displayName,
					capabilities: model.capabilities.filter(
						(capability) => !model.disabledCapabilities.includes(capability),
					),
				})),
				defaultModel: defaultModel ?? null,
			}),
		),
	);

/** A default seeded into an older workspace is still one of the defaults. */
function inListOrder<Row extends { provider: ModelProviderRow }>(rows: Row[]): Row[] {
	const rank = ({ provider: row }: Row) => {
		const seeded = row.preset ? seededPresets.indexOf(row.preset) : -1;
		return seeded === -1 ? seededPresets.length : seeded;
	};
	return rows.toSorted((a, b) => rank(a) - rank(b));
}

/** Providers with the name of whoever connected each, while they still have an account. */
function withConnectedBy(db: Executor) {
	return db
		.select({ provider: modelProvider, connectedBy: user.name })
		.from(modelProvider)
		.leftJoin(user, eq(user.id, modelProvider.connectedById));
}

function toProvider(
	row: ModelProviderRow,
	connectedBy: string | null,
	models: ProviderModelRow[],
): ModelProvider {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		preset: row.preset,
		name: row.name,
		baseUrl: row.baseUrl,
		apiFormat: row.apiFormat,
		active: row.active,
		status:
			presetSignsIn(row.preset) && row.oauthTokensEncrypted === null
				? "signed_out"
				: configurationStatus({
						missingKey: lacksCredential(row),
						lastTestedAt: row.lastTestedAt,
						lastTestError: row.lastTestError,
					}),
		hasApiKey: row.apiKeyEncrypted !== null,
		signedIn: row.oauthTokensEncrypted !== null,
		customHeaders: row.customHeadersEncrypted.map(({ name }) => ({ name })),
		modelCount: models.length,
		enabledModelCount: models.filter(({ enabled }) => enabled).length,
		lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
		lastTestError: row.lastTestError,
		// Nobody connected one that is off, or on without the key or sign-in it needs.
		connectedBy: row.active && !lacksCredential(row) ? connectedBy : null,
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

/**
 * Whether the workspace's enabled model `modelId` takes images: it reports
 * vision, and no admin switched that off. A model the workspace doesn't
 * offer takes none.
 */
export const modelAcceptsImages = (workspaceId: string, modelId: string) =>
	query((db) =>
		db
			.select({
				capabilities: providerModel.capabilities,
				disabledCapabilities: providerModel.disabledCapabilities,
			})
			.from(providerModel)
			.where(
				and(
					eq(providerModel.workspaceId, workspaceId),
					eq(providerModel.modelId, modelId),
					eq(providerModel.enabled, true),
				),
			),
	).pipe(
		Effect.map((models) =>
			models.some(
				(model) =>
					model.capabilities.includes("vision") && !model.disabledCapabilities.includes("vision"),
			),
		),
	);

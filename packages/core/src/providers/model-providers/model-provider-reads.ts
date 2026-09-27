import type { ModelProvider, WorkspaceModelsResponse } from "@sugabots/contracts";
import { effectiveCapabilities, presetRequiresApiKey } from "@sugabots/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import {
	type ModelProviderRow,
	modelProvider,
	type ProviderModelRow,
	providerModel,
} from "../../database/schema.ts";
import { apiKeyHint, configurationStatus } from "../tested-configuration.ts";
import { offeredIn } from "./model-provider-repository.ts";

/** Every model provider in the workspace, oldest first, each with its models. */
export const providersIn = (workspaceId: string) =>
	Effect.gen(function* () {
		const providers = yield* query((db) =>
			db
				.select()
				.from(modelProvider)
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
							providers.map(({ id }) => id),
						),
					),
				)
				.orderBy(asc(providerModel.displayName), asc(providerModel.modelId)),
		);
		return providers.map((provider) =>
			toProvider(
				provider,
				models.filter((model) => model.providerId === provider.id),
			),
		);
	});

/** One of the workspace's model providers, with its models, or nothing. */
export const providerIn = (workspaceId: string, providerId: string) =>
	Effect.gen(function* () {
		const [row] = yield* query((db) =>
			db
				.select()
				.from(modelProvider)
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
		return toProvider(row, models);
	});

/** The models the workspace offers for agents to run on; embedding models are not among them. */
export const offeredModels = (workspaceId: string) =>
	query((db) =>
		db
			.select({ model: providerModel, provider: modelProvider })
			.from(providerModel)
			.innerJoin(modelProvider, eq(modelProvider.id, providerModel.providerId))
			.where(offeredIn(workspaceId)),
	).pipe(
		Effect.map(
			(rows): WorkspaceModelsResponse => ({
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
			}),
		),
	);

function toProvider(row: ModelProviderRow, models: ProviderModelRow[]): ModelProvider {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		preset: row.preset,
		name: row.name,
		baseUrl: row.baseUrl,
		apiFormat: row.apiFormat,
		active: row.active,
		status: configurationStatus({
			missingKey: presetRequiresApiKey(row.preset) && !row.apiKeyEncrypted,
			lastTestedAt: row.lastTestedAt,
			lastTestError: row.lastTestError,
		}),
		hasApiKey: row.apiKeyEncrypted !== null,
		apiKeyHint: apiKeyHint(row.apiKeyEncrypted),
		customHeaders: row.customHeadersEncrypted.map(({ name }) => ({ name, valueHint: "********" })),
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

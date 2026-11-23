import type { ModelProvider, NamedPerson, WorkspaceModelsResponse } from "@sugabots/contracts";
import {
	builtInSignsIn,
	providerIsConnected,
	providerLacksCredential,
	seededBuiltIns,
} from "@sugabots/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { namedPersonColumns } from "../../chats/store/participants.ts";
import { type Executor, query } from "../../database/database.ts";
import {
	type ModelProviderRow,
	membership,
	modelProvider,
	type ProviderModelRow,
	person,
	providerModel,
} from "../../database/schema.ts";
import { configurationStatus } from "../tested-configuration.ts";
import { defaultModelOf, offeredIn } from "./model-provider-store.ts";

/**
 * Every model provider in the workspace, each with its models: the defaults
 * first, in the built-in providers' order, then the rest oldest first.
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
 * The models the workspace offers for bots to run on, and its default, which
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
					providerBuiltIn: provider.builtIn,
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

function inListOrder<Row extends { provider: ModelProviderRow }>(rows: Row[]): Row[] {
	const rank = ({ provider: row }: Row) => {
		const seeded = row.builtIn ? seededBuiltIns.indexOf(row.builtIn) : -1;
		return seeded === -1 ? seededBuiltIns.length : seeded;
	};
	return rows.toSorted((a, b) => rank(a) - rank(b));
}

/** Providers with whoever connected each, while they are still in the workspace. */
function withConnectedBy(db: Executor) {
	return db
		.select({ provider: modelProvider, connectedBy: namedPersonColumns })
		.from(modelProvider)
		.leftJoin(
			membership,
			and(
				eq(membership.workspaceId, modelProvider.workspaceId),
				eq(membership.personId, modelProvider.connectedById),
			),
		)
		.leftJoin(person, eq(person.id, membership.personId));
}

function toProvider(
	row: ModelProviderRow,
	connectedBy: NamedPerson | null,
	models: ProviderModelRow[],
): ModelProvider {
	const hasApiKey = row.apiKeyEncrypted !== null;
	const signedIn = row.oauthTokensEncrypted !== null;
	const connected = providerIsConnected({
		builtIn: row.builtIn,
		hasApiKey,
		signedIn,
		active: row.active,
	});
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		builtIn: row.builtIn,
		name: row.name,
		baseUrl: row.baseUrl,
		apiFormat: row.apiFormat,
		active: row.active,
		status:
			builtInSignsIn(row.builtIn) && row.oauthTokensEncrypted === null
				? "signed_out"
				: configurationStatus({
						missingKey: providerLacksCredential({ builtIn: row.builtIn, hasApiKey, signedIn }),
						lastTestedAt: row.lastTestedAt,
						lastTestError: row.lastTestError,
					}),
		hasApiKey,
		signedIn,
		customHeaders: row.customHeadersEncrypted.map(({ name }) => ({ name })),
		lastTestError: row.lastTestError,
		connectedBy: connected ? connectedBy : null,
		createdAt: row.createdAt.toISOString(),
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

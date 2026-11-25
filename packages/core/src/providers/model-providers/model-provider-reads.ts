import type { ModelProvider, NamedMember, WorkspaceModelsResponse } from "@sugabots/contracts";
import {
	builtInSignsIn,
	providerIsConnected,
	providerLacksCredential,
	seededBuiltIns,
} from "@sugabots/contracts";
import { DisplayName } from "@sugabots/errors";
import { and, asc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { namedMemberColumns } from "../../chats/store/participants.ts";
import { type Executor, query } from "../../database/database.ts";
import {
	type ModelProviderRow,
	member,
	membership,
	modelProvider,
	type ProviderModelRow,
	providerModel,
} from "../../database/schema.ts";
import { membershipOf } from "../../workspaces/membership/member-reads.ts";
import { configurationStatus } from "../tested-configuration.ts";
import { capabilitiesOn, defaultModelOf, offeredIn } from "./model-provider-store.ts";

/**
 * Every model provider in the workspace, each with its models: the defaults
 * first, in the built-in providers' order, then the rest oldest first.
 */
export const providersIn = (workspaceId: string) =>
	Effect.gen(function* () {
		const providers = yield* query((db) =>
			withMembers(db)
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
		return inListOrder(providers).map(({ provider, connectedBy, signedInAs }) =>
			toProvider(
				provider,
				{ connectedBy, signedInAs },
				models.filter((model) => model.providerId === provider.id),
			),
		);
	});

/** One of the workspace's model providers, with its models, or nothing. */
export const providerIn = (workspaceId: string, providerId: string) =>
	Effect.gen(function* () {
		const [row] = yield* query((db) =>
			withMembers(db)
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
		return toProvider(row.provider, row, models);
	});

/**
 * The names of the workspace's model providers that sign in with `memberId`'s
 * subscription, in the order the list shows them.
 */
export const providersSignedInAs = (workspaceId: string, memberId: string) =>
	query((db) =>
		db
			.select({ provider: modelProvider })
			.from(modelProvider)
			.where(
				and(eq(modelProvider.workspaceId, workspaceId), eq(modelProvider.signedInById, memberId)),
			)
			.orderBy(asc(modelProvider.createdAt)),
	).pipe(
		Effect.map((rows) =>
			inListOrder(rows).map(({ provider }) => DisplayName.fromRecord(provider.name)),
		),
	);

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
					capabilities: capabilitiesOn(model),
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

/** The member whose subscription a provider signs in with, beside whoever connected it. */
const signer = alias(member, "signer");
const signerMembership = alias(membership, "signer_membership");

/**
 * Providers with whoever connected each, and whose subscription each signs in
 * with, while they are still in the workspace.
 */
function withMembers(db: Executor) {
	return db
		.select({
			provider: modelProvider,
			connectedBy: namedMemberColumns,
			signedInAs: { id: signer.id, name: signer.name, email: signer.email, image: signer.image },
		})
		.from(modelProvider)
		.leftJoin(membership, membershipOf(modelProvider.workspaceId, modelProvider.connectedById))
		.leftJoin(member, eq(member.id, membership.memberId))
		.leftJoin(
			signerMembership,
			and(
				eq(signerMembership.workspaceId, modelProvider.workspaceId),
				eq(signerMembership.memberId, modelProvider.signedInById),
			),
		)
		.leftJoin(signer, eq(signer.id, signerMembership.memberId));
}

function toProvider(
	row: ModelProviderRow,
	members: { connectedBy: NamedMember | null; signedInAs: NamedMember | null },
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
			builtInSignsIn(row.builtIn) && !signedIn && !hasApiKey
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
		connectedBy: connected ? members.connectedBy : null,
		signedInAs: members.signedInAs,
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
	).pipe(Effect.map((models) => models.some((model) => capabilitiesOn(model).includes("vision"))));

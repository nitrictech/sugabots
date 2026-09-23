import {
	bulkProviderModelUpdateSchema,
	modelProviderUpdateSchema,
	newModelProviderSchema,
	newProviderModelSchema,
	providerModelUpdateSchema,
} from "@sugabots/contracts";
import type { TurnModel } from "@sugabots/core/conversations/turns/model";
import {
	type FetchedModelCapabilitiesImmutable,
	type ModelProviderNotFound,
	type ModelProviderRemovalNotAllowed,
	type ModelProviderUrlNotAllowed,
	modelProviderOperations,
	type ProviderActivationRequiresApiKey,
	type ProviderModelAlreadyConfigured,
	type ProviderModelNotFound,
	type ProviderModelRemovalNotAllowed,
	type ProviderModelsRequireApiKey,
} from "@sugabots/core/providers/model-providers/operations";
import type {
	ModelProviderNameConflict,
	ModelProviderStore,
} from "@sugabots/core/providers/model-providers/store";
import type {
	EgressHttpClients,
	EgressUrlValidator,
} from "@sugabots/core/providers/network/egress";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { Hono } from "hono";
import { type AuthEnv, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { requireWorkspace } from "../../http/authorisation.ts";
import { body } from "../../http/body.ts";
import { asHttpError, HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";

export interface ModelProviderRoutesOptions {
	resolveSession: SessionResolver;
	authorization: Authorization;
	run: RunHandler;
	modelProviders: ModelProviderStore;
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
	model: TurnModel;
}

export function createModelProviderRoutes({
	resolveSession,
	authorization,
	run,
	modelProviders,
	httpClients,
	validateProviderUrl,
	model,
}: ModelProviderRoutesOptions) {
	const session = requireSession(resolveSession);
	const inWorkspace = requireWorkspace(authorization, run, "workspace.read");
	const managesProviders = requireWorkspace(authorization, run, "workspace.providers.manage");
	const root = "/workspaces/:workspaceId/model-providers";
	const operations = modelProviderOperations({
		providers: modelProviders,
		httpClients,
		validateProviderUrl,
		model,
	});

	return new Hono<AuthEnv>()
		.get(root, session, managesProviders, async (c) =>
			c.json(await run(operations.list(c.get("workspace").workspaceId))),
		)
		.get(`${root}/models`, session, inWorkspace, async (c) =>
			c.json(await run(operations.listEnabled(c.get("workspace").workspaceId))),
		)
		.post(root, session, managesProviders, body(newModelProviderSchema), async (c) => {
			const created = await run(
				operations
					.create(c.get("workspace").workspaceId, c.get("session").user.id, c.req.valid("json"))
					.pipe(asHttpError(providerErrors)),
			);
			return c.json(created, 201);
		})
		.get(`${root}/:providerId`, session, managesProviders, async (c) =>
			c.json(
				await run(
					operations
						.get(c.get("workspace").workspaceId, c.req.param("providerId"))
						.pipe(asHttpError(providerErrors)),
				),
			),
		)
		.patch(
			`${root}/:providerId`,
			session,
			managesProviders,
			body(modelProviderUpdateSchema),
			async (c) =>
				c.json(
					await run(
						operations
							.update(
								c.get("workspace").workspaceId,
								c.req.param("providerId"),
								c.req.valid("json"),
							)
							.pipe(asHttpError(providerErrors)),
					),
				),
		)
		.delete(`${root}/:providerId`, session, managesProviders, async (c) => {
			await run(
				operations
					.remove(c.get("workspace").workspaceId, c.req.param("providerId"))
					.pipe(asHttpError(providerErrors)),
			);
			return c.body(null, 204);
		})
		.post(`${root}/:providerId/test`, session, managesProviders, async (c) =>
			c.json(
				await run(
					operations
						.test(c.get("workspace").workspaceId, c.req.param("providerId"))
						.pipe(asHttpError(providerErrors)),
				),
			),
		)
		.post(`${root}/:providerId/fetch-models`, session, managesProviders, async (c) =>
			c.json(
				await run(
					operations.fetchModels(c.get("workspace").workspaceId, c.req.param("providerId")),
				),
			),
		)
		.post(
			`${root}/:providerId/models`,
			session,
			managesProviders,
			body(newProviderModelSchema),
			async (c) => {
				const provider = await run(
					operations
						.addModel(
							c.get("workspace").workspaceId,
							c.req.param("providerId"),
							c.req.valid("json"),
						)
						.pipe(asHttpError(providerErrors)),
				);
				return c.json(provider, 201);
			},
		)
		.patch(
			`${root}/:providerId/models`,
			session,
			managesProviders,
			body(bulkProviderModelUpdateSchema),
			async (c) => {
				const { modelIds, enabled } = c.req.valid("json");
				const updated = await run(
					operations
						.setModelsEnabled(
							c.get("workspace").workspaceId,
							c.req.param("providerId"),
							modelIds,
							enabled,
						)
						.pipe(asHttpError(providerErrors)),
				);
				return c.json({ updated });
			},
		)
		.patch(
			`${root}/:providerId/models/:modelId`,
			session,
			managesProviders,
			body(providerModelUpdateSchema),
			async (c) => {
				const updated = await run(
					operations
						.updateModel(
							c.get("workspace").workspaceId,
							c.req.param("providerId"),
							c.req.param("modelId"),
							c.req.valid("json"),
						)
						.pipe(asHttpError(providerErrors)),
				);
				return c.json({ updated });
			},
		)
		.delete(`${root}/:providerId/models/:modelId`, session, managesProviders, async (c) => {
			await run(
				operations
					.removeModel(
						c.get("workspace").workspaceId,
						c.req.param("providerId"),
						c.req.param("modelId"),
					)
					.pipe(asHttpError(providerErrors)),
			);
			return c.body(null, 204);
		});
}

const providerErrors = {
	ModelProviderNameConflict: (failure: ModelProviderNameConflict) =>
		new HttpError("conflict", failure.message),
	ModelProviderNotFound: (failure: ModelProviderNotFound) =>
		new HttpError("not_found", failure.message),
	ModelProviderUrlNotAllowed: (failure: ModelProviderUrlNotAllowed) =>
		new HttpError("bad_request", failure.message),
	ProviderModelsRequireApiKey: (failure: ProviderModelsRequireApiKey) =>
		new HttpError("bad_request", failure.message),
	ProviderActivationRequiresApiKey: (failure: ProviderActivationRequiresApiKey) =>
		new HttpError("bad_request", failure.message),
	ModelProviderRemovalNotAllowed: (failure: ModelProviderRemovalNotAllowed) =>
		new HttpError("bad_request", failure.message),
	ProviderModelAlreadyConfigured: (failure: ProviderModelAlreadyConfigured) =>
		new HttpError("conflict", failure.message),
	FetchedModelCapabilitiesImmutable: (failure: FetchedModelCapabilitiesImmutable) =>
		new HttpError("bad_request", failure.message),
	ProviderModelNotFound: (failure: ProviderModelNotFound) =>
		new HttpError("not_found", failure.message),
	ProviderModelRemovalNotAllowed: (failure: ProviderModelRemovalNotAllowed) =>
		new HttpError("bad_request", failure.message),
};

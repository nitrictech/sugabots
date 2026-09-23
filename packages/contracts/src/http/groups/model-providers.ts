import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	bulkProviderModelUpdateSchema,
	modelProviderSchema,
	modelProviderUpdateSchema,
	newModelProviderSchema,
	newProviderModelSchema,
	providerFetchResultSchema,
	providerModelUpdateSchema,
	providerTestResultSchema,
	workspaceModelsResponseSchema,
} from "../../model-providers.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict } from "../errors.ts";
import { Authorise, Session } from "../middleware.ts";

const root = "/workspaces/:workspaceId/model-providers";
const workspace = { workspaceId: uuidSchema };
const provider = { workspaceId: uuidSchema, providerId: uuidSchema };
const model = { ...provider, modelId: Schema.String };

/** How many models a change reached. */
const updatedCountSchema = Schema.Struct({
	updated: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export class ModelProvidersApi extends HttpApiGroup.make("modelProviders")
	.add(
		HttpApiEndpoint.get("list", root, {
			params: workspace,
			success: Schema.Array(modelProviderSchema),
		}),
		HttpApiEndpoint.get("listEnabledModels", `${root}/models`, {
			params: workspace,
			success: workspaceModelsResponseSchema,
		}),
		HttpApiEndpoint.post("create", root, {
			params: workspace,
			payload: newModelProviderSchema,
			success: modelProviderSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict],
		}),
		HttpApiEndpoint.get("get", `${root}/:providerId`, {
			params: provider,
			success: modelProviderSchema,
		}),
		HttpApiEndpoint.patch("update", `${root}/:providerId`, {
			params: provider,
			payload: modelProviderUpdateSchema,
			success: modelProviderSchema,
			error: [BadRequest, Conflict],
		}),
		HttpApiEndpoint.delete("remove", `${root}/:providerId`, {
			params: provider,
			error: BadRequest,
		}),
		HttpApiEndpoint.post("test", `${root}/:providerId/test`, {
			params: provider,
			success: providerTestResultSchema,
		}),
		HttpApiEndpoint.post("fetchModels", `${root}/:providerId/fetch-models`, {
			params: provider,
			success: providerFetchResultSchema,
		}),
		HttpApiEndpoint.post("addModel", `${root}/:providerId/models`, {
			params: provider,
			payload: newProviderModelSchema,
			success: modelProviderSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict],
		}),
		HttpApiEndpoint.patch("setModelsEnabled", `${root}/:providerId/models`, {
			params: provider,
			payload: bulkProviderModelUpdateSchema,
			success: updatedCountSchema,
			error: BadRequest,
		}),
		HttpApiEndpoint.patch("updateModel", `${root}/:providerId/models/:modelId`, {
			params: model,
			payload: providerModelUpdateSchema,
			success: updatedCountSchema,
			error: BadRequest,
		}),
		HttpApiEndpoint.delete("removeModel", `${root}/:providerId/models/:modelId`, {
			params: model,
			error: BadRequest,
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}

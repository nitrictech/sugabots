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
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/workspaces/:workspace/model-providers";
const workspace = { workspace: workspaceIdOrSlugSchema };
const provider = { workspace: workspaceIdOrSlugSchema, providerId: uuidSchema };
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
			error: refused,
		}),
		HttpApiEndpoint.get("listEnabledModels", `${root}/models`, {
			params: workspace,
			success: workspaceModelsResponseSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("create", root, {
			params: workspace,
			payload: newModelProviderSchema,
			success: modelProviderSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.get("get", `${root}/:providerId`, {
			params: provider,
			success: modelProviderSchema,
			error: refused,
		}),
		HttpApiEndpoint.patch("update", `${root}/:providerId`, {
			params: provider,
			payload: modelProviderUpdateSchema,
			success: modelProviderSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.delete("remove", `${root}/:providerId`, {
			params: provider,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.post("test", `${root}/:providerId/test`, {
			params: provider,
			success: providerTestResultSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("fetchModels", `${root}/:providerId/fetch-models`, {
			params: provider,
			success: providerFetchResultSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("addModel", `${root}/:providerId/models`, {
			params: provider,
			payload: newProviderModelSchema,
			success: modelProviderSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.patch("setModelsEnabled", `${root}/:providerId/models`, {
			params: provider,
			payload: bulkProviderModelUpdateSchema,
			success: updatedCountSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.patch("updateModel", `${root}/:providerId/models/:modelId`, {
			params: model,
			payload: providerModelUpdateSchema,
			success: updatedCountSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("removeModel", `${root}/:providerId/models/:modelId`, {
			params: model,
			error: [BadRequest, ...refused],
		}),
	)
	.middleware(Session) {}

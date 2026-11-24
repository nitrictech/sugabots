import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	defaultModelUpdateSchema,
	modelProviderSchema,
	modelProviderUpdateSchema,
	newModelProviderSchema,
	newProviderModelSchema,
	providerModelSwitchOffSchema,
	providerModelUpdateSchema,
	providerSignInCompletionSchema,
	providerSignInOutcomeSchema,
	providerSignInStartedSchema,
	providerSwitchOffSchema,
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
const model = { ...provider, modelId: uuidSchema };

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
		HttpApiEndpoint.put("setDefaultModel", `${root}/models/default`, {
			params: workspace,
			payload: defaultModelUpdateSchema,
			success: workspaceModelsResponseSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.post("create", root, {
			params: workspace,
			payload: newModelProviderSchema,
			success: modelProviderSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.patch("update", `${root}/:providerId`, {
			params: provider,
			payload: modelProviderUpdateSchema,
			success: modelProviderSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.delete("remove", `${root}/:providerId`, {
			params: provider,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.post("switchOff", `${root}/:providerId/switch-off`, {
			params: provider,
			payload: providerSwitchOffSchema,
			success: HttpApiSchema.Empty(204),
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.post("test", `${root}/:providerId/test`, {
			params: provider,
			success: providerTestResultSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("startSignIn", `${root}/:providerId/sign-in`, {
			params: provider,
			success: providerSignInStartedSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.post("completeSignIn", `${root}/:providerId/sign-in/complete`, {
			params: provider,
			payload: providerSignInCompletionSchema,
			success: providerSignInOutcomeSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("signOut", `${root}/:providerId/sign-in`, {
			params: provider,
			success: modelProviderSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.post("discoverModels", `${root}/:providerId/discover-models`, {
			params: provider,
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		HttpApiEndpoint.post("addModel", `${root}/:providerId/models`, {
			params: provider,
			payload: newProviderModelSchema,
			success: modelProviderSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.patch("updateModel", `${root}/:providerId/models/:modelId`, {
			params: model,
			payload: providerModelUpdateSchema,
			success: HttpApiSchema.Empty(204),
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.post("switchOffModel", `${root}/:providerId/models/:modelId/switch-off`, {
			params: model,
			payload: providerModelSwitchOffSchema,
			success: HttpApiSchema.Empty(204),
			error: [BadRequest, Conflict, ...refused],
		}),
	)
	.middleware(Session) {}

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	newSearchProviderSchema,
	searchProviderResponseSchema,
	searchProviderSchema,
	searchProviderTestResultSchema,
	searchProviderUpdateSchema,
	webAccessSchema,
} from "../../search-providers.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest } from "../errors.ts";
import { Authorise, Session } from "../middleware.ts";

/** A workspace has at most one search provider, so it is addressed by the workspace alone. */
const root = "/workspaces/:workspace/search-provider";
const params = { workspace: workspaceIdOrSlugSchema };

export class SearchProvidersApi extends HttpApiGroup.make("searchProviders")
	.add(
		HttpApiEndpoint.get("get", root, { params, success: searchProviderResponseSchema }),
		HttpApiEndpoint.get("webAccess", `${root}/web-access`, { params, success: webAccessSchema }),
		HttpApiEndpoint.put("replace", root, {
			params,
			payload: newSearchProviderSchema,
			success: searchProviderSchema.pipe(HttpApiSchema.status(201)),
			error: BadRequest,
		}),
		HttpApiEndpoint.patch("update", root, {
			params,
			payload: searchProviderUpdateSchema,
			success: searchProviderSchema,
			error: BadRequest,
		}),
		HttpApiEndpoint.delete("remove", root, { params }),
		HttpApiEndpoint.post("test", `${root}/test`, {
			params,
			success: searchProviderTestResultSchema,
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}

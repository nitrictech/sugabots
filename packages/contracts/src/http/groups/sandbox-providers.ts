import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	newSandboxHostSchema,
	newSandboxProviderSchema,
	sandboxAccessSchema,
	sandboxHostSchema,
	sandboxNetworkSettingsSchema,
	sandboxProviderSchema,
	sandboxProviderTestResultSchema,
	sandboxProviderUpdateSchema,
	sandboxTemplateSchema,
} from "../../sandbox-providers.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/workspaces/:workspace/sandbox-providers";
const network = "/workspaces/:workspace/sandbox-network";
const workspace = { workspace: workspaceIdOrSlugSchema };
const provider = { workspace: workspaceIdOrSlugSchema, providerId: uuidSchema };

export class SandboxProvidersApi extends HttpApiGroup.make("sandboxProviders")
	.add(
		HttpApiEndpoint.get("list", root, {
			params: workspace,
			success: Schema.Array(sandboxProviderSchema),
			error: refused,
		}),
		HttpApiEndpoint.get("access", `${root}/access`, {
			params: workspace,
			success: sandboxAccessSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("create", root, {
			params: workspace,
			payload: newSandboxProviderSchema,
			success: sandboxProviderSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.patch("update", `${root}/:providerId`, {
			params: provider,
			payload: sandboxProviderUpdateSchema,
			success: sandboxProviderSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("remove", `${root}/:providerId`, {
			params: provider,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.get("template", `${root}/:providerId/template`, {
			params: provider,
			success: sandboxTemplateSchema,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.post("prepareTemplate", `${root}/:providerId/template`, {
			params: provider,
			success: sandboxTemplateSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.post("test", `${root}/:providerId/test`, {
			params: provider,
			success: sandboxProviderTestResultSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("network", network, {
			params: workspace,
			success: sandboxNetworkSettingsSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("addHost", `${network}/hosts`, {
			params: workspace,
			payload: newSandboxHostSchema,
			success: sandboxNetworkSettingsSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("removeHost", `${network}/hosts/:host`, {
			params: { workspace: workspaceIdOrSlugSchema, host: sandboxHostSchema },
			success: sandboxNetworkSettingsSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("blockHost", `${network}/blocked-hosts`, {
			params: workspace,
			payload: newSandboxHostSchema,
			success: sandboxNetworkSettingsSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("unblockHost", `${network}/blocked-hosts/:host`, {
			params: { workspace: workspaceIdOrSlugSchema, host: sandboxHostSchema },
			success: sandboxNetworkSettingsSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}

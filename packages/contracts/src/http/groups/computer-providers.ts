import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	computerAccessSchema,
	computerHostSchema,
	computerNetworkSettingsSchema,
	computerProviderSchema,
	computerProviderUpdateSchema,
	computerTemplateSchema,
	newComputerHostSchema,
	newComputerProviderSchema,
	projectComputerDiskSchema,
} from "../../computer-providers.ts";
import { providerTestResultSchema } from "../../model-providers.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/workspaces/:workspace/computer-providers";
const network = "/workspaces/:workspace/computer-network";
const disks = "/workspaces/:workspace/computer-disks";
const workspace = { workspace: workspaceIdOrSlugSchema };
const provider = { workspace: workspaceIdOrSlugSchema, providerId: uuidSchema };

export class ComputerProvidersApi extends HttpApiGroup.make("computerProviders")
	.add(
		HttpApiEndpoint.get("list", root, {
			params: workspace,
			success: Schema.Array(computerProviderSchema),
			error: refused,
		}),
		HttpApiEndpoint.get("access", `${root}/access`, {
			params: workspace,
			success: computerAccessSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("create", root, {
			params: workspace,
			payload: newComputerProviderSchema,
			success: computerProviderSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.patch("update", `${root}/:providerId`, {
			params: provider,
			payload: computerProviderUpdateSchema,
			success: computerProviderSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.delete("remove", `${root}/:providerId`, {
			params: provider,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.get("template", `${root}/:providerId/template`, {
			params: provider,
			success: computerTemplateSchema,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.post("prepareTemplate", `${root}/:providerId/template`, {
			params: provider,
			success: computerTemplateSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.post("test", `${root}/:providerId/test`, {
			params: provider,
			success: providerTestResultSchema,
			error: refused,
		}),
		/** How full the disks of the computers of the projects the member reaches are, of those measured. */
		HttpApiEndpoint.get("disks", disks, {
			params: workspace,
			success: Schema.Array(projectComputerDiskSchema),
			error: refused,
		}),
		HttpApiEndpoint.get("network", network, {
			params: workspace,
			success: computerNetworkSettingsSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("addHost", `${network}/hosts`, {
			params: workspace,
			payload: newComputerHostSchema,
			success: computerNetworkSettingsSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("removeHost", `${network}/hosts/:host`, {
			params: { workspace: workspaceIdOrSlugSchema, host: computerHostSchema },
			success: computerNetworkSettingsSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("blockHost", `${network}/blocked-hosts`, {
			params: workspace,
			payload: newComputerHostSchema,
			success: computerNetworkSettingsSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("unblockHost", `${network}/blocked-hosts/:host`, {
			params: { workspace: workspaceIdOrSlugSchema, host: computerHostSchema },
			success: computerNetworkSettingsSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}

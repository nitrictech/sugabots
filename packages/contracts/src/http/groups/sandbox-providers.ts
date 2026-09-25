import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	newSandboxProviderSchema,
	podSandboxDesktopSchema,
	podSandboxStatusSchema,
	sandboxProviderResponseSchema,
	sandboxProviderSchema,
	sandboxProviderTestResultSchema,
	sandboxProviderUpdateSchema,
} from "../../sandbox-providers.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest } from "../errors.ts";
import { Authorise, Session } from "../middleware.ts";

/** A workspace has at most one sandbox provider, so it is addressed by the workspace alone. */
const root = "/workspaces/:workspace/sandbox-provider";
const params = { workspace: workspaceIdOrSlugSchema };

export class SandboxProvidersApi extends HttpApiGroup.make("sandboxProviders")
	.add(
		HttpApiEndpoint.get("get", root, { params, success: sandboxProviderResponseSchema }),
		HttpApiEndpoint.put("replace", root, {
			params,
			payload: newSandboxProviderSchema,
			success: sandboxProviderSchema.pipe(HttpApiSchema.status(201)),
			error: BadRequest,
		}),
		HttpApiEndpoint.patch("update", root, {
			params,
			payload: sandboxProviderUpdateSchema,
			success: sandboxProviderSchema,
			error: BadRequest,
		}),
		HttpApiEndpoint.delete("remove", root, { params }),
		HttpApiEndpoint.post("test", `${root}/test`, {
			params,
			success: sandboxProviderTestResultSchema,
		}),
		// Anyone in the pod may see whether its sandbox is up; configuring it is the admins'.
		HttpApiEndpoint.get("podStatus", "/pods/:podId/sandbox", {
			params: { podId: uuidSchema },
			success: podSandboxStatusSchema,
		}),
		HttpApiEndpoint.get("podDesktop", "/pods/:podId/sandbox/desktop", {
			params: { podId: uuidSchema },
			success: podSandboxDesktopSchema,
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}

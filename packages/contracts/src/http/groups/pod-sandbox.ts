import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
	newSandboxHostSchema,
	podSandboxNetworkSchema,
	podSandboxSchema,
	podSandboxSoftwareSchema,
	sandboxHostSchema,
	sandboxPackageNameSchema,
	sandboxSoftwareChannelSchema,
} from "../../sandbox-providers.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/pods/:podId/sandbox";
const params = { podId: uuidSchema };

/**
 * A pod's sandbox: how it stands, starting it afresh or moving its work to the
 * current image, the hosts it may reach beyond what the workspace allows, and
 * the software it has beyond its image.
 */
export class PodSandboxApi extends HttpApiGroup.make("podSandbox")
	.add(
		HttpApiEndpoint.get("get", root, { params, success: podSandboxSchema, error: refused }),
		HttpApiEndpoint.post("reset", `${root}/reset`, {
			params,
			success: podSandboxSchema,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.post("upgrade", `${root}/upgrade`, {
			params,
			success: podSandboxSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.get("network", `${root}/network`, {
			params,
			success: podSandboxNetworkSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("addHost", `${root}/network/hosts`, {
			params,
			payload: newSandboxHostSchema,
			success: podSandboxNetworkSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("removeHost", `${root}/network/hosts/:host`, {
			params: { ...params, host: sandboxHostSchema },
			success: podSandboxNetworkSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("software", `${root}/software`, {
			params,
			success: podSandboxSoftwareSchema,
			error: refused,
		}),
		HttpApiEndpoint.delete("removePackage", `${root}/software/:channel/:name`, {
			params: { ...params, channel: sandboxSoftwareChannelSchema, name: sandboxPackageNameSchema },
			success: podSandboxSoftwareSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}

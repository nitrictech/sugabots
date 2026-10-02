import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
	newSandboxHostSchema,
	podSandboxNetworkSchema,
	podSandboxSchema,
	sandboxHostSchema,
} from "../../sandbox-providers.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/pods/:podId/sandbox";
const params = { podId: uuidSchema };

/**
 * A pod's sandbox: how it stands, starting it afresh or moving its work to the
 * current image, and the hosts it may reach beyond what the workspace allows.
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
	)
	.middleware(Session) {}

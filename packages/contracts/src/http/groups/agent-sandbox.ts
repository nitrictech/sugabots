import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
	agentSandboxNetworkSchema,
	agentSandboxSchema,
	newSandboxHostSchema,
	sandboxHostSchema,
} from "../../sandbox-providers.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/agents/:agentId/sandbox";
const params = { agentId: uuidSchema };

/**
 * A bot's computer: how it stands, starting it afresh or moving its work to
 * the current image, and the hosts it may reach beyond what the workspace
 * allows.
 */
export class AgentSandboxApi extends HttpApiGroup.make("agentSandbox")
	.add(
		HttpApiEndpoint.get("get", root, { params, success: agentSandboxSchema, error: refused }),
		HttpApiEndpoint.post("reset", `${root}/reset`, {
			params,
			success: agentSandboxSchema,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.post("upgrade", `${root}/upgrade`, {
			params,
			success: agentSandboxSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.get("network", `${root}/network`, {
			params,
			success: agentSandboxNetworkSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("addHost", `${root}/network/hosts`, {
			params,
			payload: newSandboxHostSchema,
			success: agentSandboxNetworkSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("removeHost", `${root}/network/hosts/:host`, {
			params: { ...params, host: sandboxHostSchema },
			success: agentSandboxNetworkSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}

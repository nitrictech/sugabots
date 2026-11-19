import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
	computerHostSchema,
	newComputerHostSchema,
	projectComputerNetworkSchema,
	projectComputerSchema,
} from "../../computer-providers.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/projects/:projectId/computer";
const params = { projectId: uuidSchema };

/**
 * A project's computer, a bot's being its default project's: how it stands,
 * starting it afresh or moving its work to the current image, and the hosts
 * it may reach beyond what the workspace allows.
 */
export class ProjectComputerApi extends HttpApiGroup.make("projectComputer")
	.add(
		HttpApiEndpoint.get("get", root, { params, success: projectComputerSchema, error: refused }),
		HttpApiEndpoint.post("reset", `${root}/reset`, {
			params,
			success: projectComputerSchema,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.post("upgrade", `${root}/upgrade`, {
			params,
			success: projectComputerSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.get("network", `${root}/network`, {
			params,
			success: projectComputerNetworkSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("addHost", `${root}/network/hosts`, {
			params,
			payload: newComputerHostSchema,
			success: projectComputerNetworkSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("removeHost", `${root}/network/hosts/:host`, {
			params: { ...params, host: computerHostSchema },
			success: projectComputerNetworkSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}

import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
	botComputerNetworkSchema,
	botComputerSchema,
	computerHostSchema,
	newComputerHostSchema,
} from "../../computer-providers.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/bots/:botId/computer";
const params = { botId: uuidSchema };

/**
 * A bot's computer: how it stands, starting it afresh or moving its work to
 * the current image, and the hosts it may reach beyond what the workspace
 * allows.
 */
export class BotComputerApi extends HttpApiGroup.make("botComputer")
	.add(
		HttpApiEndpoint.get("get", root, { params, success: botComputerSchema, error: refused }),
		HttpApiEndpoint.post("reset", `${root}/reset`, {
			params,
			success: botComputerSchema,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.post("upgrade", `${root}/upgrade`, {
			params,
			success: botComputerSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.get("network", `${root}/network`, {
			params,
			success: botComputerNetworkSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("addHost", `${root}/network/hosts`, {
			params,
			payload: newComputerHostSchema,
			success: botComputerNetworkSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("removeHost", `${root}/network/hosts/:host`, {
			params: { ...params, host: computerHostSchema },
			success: botComputerNetworkSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}

import { Context } from "effect";
import type { OperationContracts, OwnEndpointOperationName } from "../operations/index.ts";
import { Tier } from "../tiers.ts";

/**
 * The operation an endpoint written by hand serves, as an annotation on the
 * endpoint: one whose contract says the HTTP API serves it at an endpoint of
 * its own, so no endpoint can say it serves one held back. Each such
 * operation is served by exactly one endpoint; an endpoint with none, such
 * as `/health`, serves no operation.
 */
export class ServedOperation extends Context.Service<
	ServedOperation,
	OwnEndpointOperationName<OperationContracts>
>()("sugabots/http/ServedOperation") {
	declare readonly [Tier]: "process";
}

/**
 * Why a group written by hand is an entrypoint of its own rather than part
 * of the HTTP API, as an annotation on the group: the event stream and
 * webhooks, which start the operations named in their own code, held back
 * from the HTTP API, for principals they authenticate themselves.
 */
export class Entrypoint extends Context.Service<Entrypoint, string>()("sugabots/http/Entrypoint") {
	declare readonly [Tier]: "process";
}

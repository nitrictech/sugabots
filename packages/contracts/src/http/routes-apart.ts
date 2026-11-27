import type { HttpApiGroup } from "effect/unstable/httpapi";
import type { OfferedRoute, OperationContract, RoutePattern } from "../operations/index.ts";

/** Where `Endpoint` answers, as `<method> <path>`, matched as the router matches it. */
type EndpointRoute<Endpoint> = Endpoint extends {
	readonly method: infer Method extends string;
	readonly path: infer Path extends string;
}
	? `${Method} ${RoutePattern<Path>}`
	: never;

/** Where the endpoints of `Groups` answer. */
type GroupRoutes<Groups extends HttpApiGroup.Constraint> = EndpointRoute<
	HttpApiGroup.Endpoints<Groups>
>;

/** The operations among `Contracts` offered where an endpoint of `Groups` answers. */
type OfferedAtGroupRoutes<Contracts, Groups extends HttpApiGroup.Constraint> = {
	[Name in keyof Contracts]: Contracts[Name] extends OperationContract.Contract
		? [OfferedRoute<Contracts[Name]["http"]>] extends [never]
			? never
			: OfferedRoute<Contracts[Name]["http"]> extends GroupRoutes<Groups>
				? Name
				: never
		: never;
}[keyof Contracts];

/**
 * `true` when no operation among `Contracts` is offered at a route an
 * endpoint written by hand in `Groups` answers, matched as the router
 * matches them; otherwise the operations that are, which would collide when
 * the router is put together.
 */
export type RoutesApart<Contracts, Groups extends HttpApiGroup.Constraint> = [
	OfferedAtGroupRoutes<Contracts, Groups>,
] extends [never]
	? true
	: {
			readonly "offered at a route an endpoint written by hand already answers: offer it elsewhere, or serve it at that endpoint as its own": OfferedAtGroupRoutes<
				Contracts,
				Groups
			>;
		};

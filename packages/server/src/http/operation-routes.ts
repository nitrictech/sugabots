import { type OperationGroup, operationGroups } from "@sugabots/contracts/http";
import {
	type HttpOperationName,
	type OperationContracts,
	operationContracts,
} from "@sugabots/contracts/operations";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder, type HttpApiGroup } from "effect/unstable/httpapi";
import { operationCaller } from "../auth/middleware.ts";
import { ServerApi } from "./api.ts";
import { answerAsHttp } from "./errors.ts";
import { invalidRequest } from "./validation.ts";

/** The parts of a request to an operation's endpoint that its input is made from. */
interface DecodedRequest {
	readonly params?: object;
	readonly query?: object;
	readonly payload?: object;
}

/**
 * The handlers of every operation the HTTP API offers, one per endpoint
 * `operationGroups` derives from the contracts, and all the same: the
 * endpoint's schemas have decoded the request's path parameters, query and
 * body, which together are the operation's input; the input is held to the
 * contract's whole input schema, whose checks across fields, such as a
 * message needing text or a file, no one part's schema has; the operation is
 * called with it for the member whose session the request carries; and what
 * it fails with is answered as `failureForError` says. Access is the
 * operation's to decide.
 */
export const operationRoutes = (() => {
	const [first, ...rest] = operationGroups;
	return Layer.mergeAll(groupRoutes(first), ...rest.map(groupRoutes));
})() as Layer.Layer<
	HttpApiGroup.Service<"sugabots", OperationGroup["identifier"]>,
	Layer.Error<ReturnType<typeof groupRoutes>>,
	Layer.Services<ReturnType<typeof groupRoutes>>
>;

function groupRoutes(group: HttpApiGroup.Constraint) {
	return HttpApiBuilder.group(
		ServerApi,
		group.identifier as OperationGroup["identifier"],
		(handlers) =>
			Effect.map(operationCaller, (callOperation) => {
				// One handler for every endpoint, so each one's own types are of no use here.
				let served = handlers as unknown as {
					handle: (
						endpoint: string,
						handler: (request: DecodedRequest) => Effect.Effect<unknown, unknown>,
					) => typeof served;
				};
				for (const endpoint of Object.keys(group.endpoints)) {
					const operation =
						`${group.identifier}.${endpoint}` as HttpOperationName<OperationContracts>;
					const admitInput = Schema.decodeUnknownEffect(
						Schema.toType(operationContracts[operation].input),
					);
					served = served.handle(endpoint, ({ params, query, payload }) =>
						admitInput({ ...params, ...query, ...payload }).pipe(
							Effect.mapError((error) => invalidRequest(error.issue)),
							Effect.flatMap((input) =>
								callOperation(operation, input as never).pipe(answerAsHttp),
							),
						),
					);
				}
				return served as unknown as typeof handlers;
			}),
	);
}

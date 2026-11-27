import { HttpApi } from "effect/unstable/httpapi";
import { type OperationContracts, requireTrue } from "../operations/index.ts";
import { ChatFilesApi } from "./groups/chat-files.ts";
import { EventStreamsApi } from "./groups/event-streams.ts";
import { SessionApi } from "./groups/session.ts";
import { SignInCallbacksApi } from "./groups/sign-in-callbacks.ts";
import { WebhooksApi } from "./groups/webhooks.ts";
import { ValidateRequest } from "./middleware.ts";
import { operationGroups } from "./operation-groups.ts";
import type { RoutesApart } from "./routes-apart.ts";

/** The path under the server's `publicUrl` the API answers at, better-auth's routes included. */
export const API_BASE_PATH = "/api";

/** The groups written by hand, beside the operations' derived ones. */
type HandWrittenGroup =
	| typeof SessionApi
	| typeof ChatFilesApi
	| typeof SignInCallbacksApi
	| typeof EventStreamsApi
	| typeof WebhooksApi;

requireTrue<RoutesApart<OperationContracts, HandWrittenGroup>>();

/**
 * The whole API, as data: an endpoint for each operation offered over HTTP,
 * derived from its contract, and the endpoints written by hand, each group
 * saying why it is one.
 *
 * The server implements it group by group, and `packages/sdk` derives its
 * client from it, so a route exists in both places or neither. Its paths are
 * relative to `API_BASE_PATH`.
 */
export class Api extends HttpApi.make("sugabots")
	.add(...operationGroups)
	.add(SessionApi, ChatFilesApi, SignInCallbacksApi, EventStreamsApi, WebhooksApi)
	.middleware(ValidateRequest) {}

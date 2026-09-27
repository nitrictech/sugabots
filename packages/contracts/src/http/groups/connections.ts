import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	CONNECTION_SIGN_IN_CALLBACK_PATH,
	connectFromCatalogResultSchema,
	connectFromCatalogSchema,
	connectionOauthStartSchema,
	connectionSchema,
	connectionTestResultSchema,
	connectionUpdateSchema,
	newConnectionSchema,
} from "../../connections.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict } from "../errors.ts";
import { Authorise, Session } from "../middleware.ts";

const root = "/pods/:podId/connections";
const pod = { podId: uuidSchema };
const connection = { podId: uuidSchema, connectionId: uuidSchema };

export class ConnectionsApi extends HttpApiGroup.make("connections")
	.add(
		HttpApiEndpoint.get("list", root, {
			params: pod,
			success: Schema.Array(connectionSchema),
		}),
		HttpApiEndpoint.post("create", root, {
			params: pod,
			payload: newConnectionSchema,
			success: connectionSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict],
		}),
		HttpApiEndpoint.get("get", `${root}/:connectionId`, {
			params: connection,
			success: connectionSchema,
		}),
		HttpApiEndpoint.patch("update", `${root}/:connectionId`, {
			params: connection,
			payload: connectionUpdateSchema,
			success: connectionSchema,
			error: [BadRequest, Conflict],
		}),
		HttpApiEndpoint.delete("remove", `${root}/:connectionId`, { params: connection }),
		HttpApiEndpoint.post("test", `${root}/:connectionId/test`, {
			params: connection,
			success: connectionTestResultSchema,
		}),
		// Makes the connection and starts its sign-in in one request, so a
		// catalog entry is one click.
		HttpApiEndpoint.post("connectFromCatalog", `${root}/connect`, {
			params: pod,
			payload: connectFromCatalogSchema,
			success: connectFromCatalogResultSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict],
		}),
		HttpApiEndpoint.post("startOAuth", `${root}/:connectionId/oauth/start`, {
			params: connection,
			success: connectionOauthStartSchema,
			error: BadRequest,
		}),
		// Where the authorization server sends the browser back. It answers with
		// a redirect to the web app, success or not, since a browser is reading it.
		HttpApiEndpoint.get("oauthCallback", CONNECTION_SIGN_IN_CALLBACK_PATH, {
			query: {
				code: Schema.optional(Schema.String),
				state: Schema.optional(Schema.String),
				error: Schema.optional(Schema.String),
				error_description: Schema.optional(Schema.String),
			},
			success: HttpApiSchema.Empty(302),
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}

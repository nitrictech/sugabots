import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	CONNECTOR_SIGN_IN_CALLBACK_PATH,
	connectBuiltInResultSchema,
	connectBuiltInSchema,
	connectorListItemSchema,
	connectorOauthStartSchema,
	connectorSchema,
	connectorTestResultSchema,
	connectorUpdateSchema,
	connectorWithToolsSchema,
	newConnectorSchema,
	unsavedConnectorSchema,
} from "../../connectors.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, NotFound, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/projects/:projectId/connectors";
const project = { projectId: uuidSchema };
const connector = { projectId: uuidSchema, connectorId: uuidSchema };

/** A project's connectors; a bot's are its default project's. */
export class ConnectorsApi extends HttpApiGroup.make("connectors")
	.add(
		HttpApiEndpoint.get("list", root, {
			params: project,
			success: Schema.Array(connectorListItemSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("create", root, {
			params: project,
			payload: newConnectorSchema,
			success: connectorSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		// Tests an address and secret without saving them, or anything about the test.
		HttpApiEndpoint.post("testUnsaved", `${root}/test`, {
			params: project,
			payload: unsavedConnectorSchema,
			success: connectorTestResultSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.get("get", `${root}/:connectorId`, {
			params: connector,
			success: connectorWithToolsSchema,
			error: refused,
		}),
		HttpApiEndpoint.patch("update", `${root}/:connectorId`, {
			params: connector,
			payload: connectorUpdateSchema,
			success: connectorListItemSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.delete("remove", `${root}/:connectorId`, {
			params: connector,
			error: refused,
		}),
		HttpApiEndpoint.post("test", `${root}/:connectorId/test`, {
			params: connector,
			success: connectorTestResultSchema,
			error: refused,
		}),
		// Makes the connector and starts its sign-in in one request, so a
		// built-in connector is one click.
		HttpApiEndpoint.post("connectBuiltIn", `${root}/connect`, {
			params: project,
			payload: connectBuiltInSchema,
			success: connectBuiltInResultSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.post("startOAuth", `${root}/:connectorId/oauth/start`, {
			params: connector,
			success: connectorOauthStartSchema,
			error: [BadRequest, ...refused],
		}),
		// Where the authorization server sends the browser back. It answers with
		// a redirect to the web app, success or not, since a browser is reading it.
		HttpApiEndpoint.get("oauthCallback", CONNECTOR_SIGN_IN_CALLBACK_PATH, {
			query: {
				code: Schema.optional(Schema.String),
				state: Schema.optional(Schema.String),
				error: Schema.optional(Schema.String),
				error_description: Schema.optional(Schema.String),
			},
			success: HttpApiSchema.Empty(302),
			error: NotFound,
		}),
	)
	.middleware(Session) {}

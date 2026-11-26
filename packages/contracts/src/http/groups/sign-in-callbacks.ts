import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { CONNECTOR_SIGN_IN_CALLBACK_PATH } from "../../connectors.ts";
import { GITHUB_APP_INSTALLED_PATH, GITHUB_APP_MADE_PATH } from "../../github.ts";
import { NotFound } from "../errors.ts";
import { Session } from "../middleware.ts";
import { ServedOperation } from "../served.ts";

/**
 * Where an authorization server or GitHub sends the browser back to, to
 * finish a sign-in the member's session started. Written by hand, because
 * each answers with a redirect, since a browser is reading it, and takes the
 * query its sender names.
 */
export class SignInCallbacksApi extends HttpApiGroup.make("signInCallbacks")
	.add(
		// A connector's sign-in: the web app hears how it went from the redirect.
		HttpApiEndpoint.get("oauthCallback", CONNECTOR_SIGN_IN_CALLBACK_PATH, {
			query: {
				code: Schema.optional(Schema.String),
				state: Schema.optional(Schema.String),
				error: Schema.optional(Schema.String),
				error_description: Schema.optional(Schema.String),
			},
			success: HttpApiSchema.Empty(302),
			error: NotFound,
		}).annotate(ServedOperation, "connectors.oauthCallback"),
		HttpApiEndpoint.get("gitHubAppMade", GITHUB_APP_MADE_PATH, {
			query: { code: Schema.optional(Schema.String), state: Schema.optional(Schema.String) },
			success: HttpApiSchema.Empty(302),
		}).annotate(ServedOperation, "gitHubConnectors.gitHubAppMade"),
		HttpApiEndpoint.get("gitHubAppInstalled", GITHUB_APP_INSTALLED_PATH, {
			query: {
				installation_id: Schema.optional(Schema.NumberFromString.check(Schema.isInt())),
				state: Schema.optional(Schema.String),
			},
			success: HttpApiSchema.Empty(302),
		}).annotate(ServedOperation, "gitHubConnectors.gitHubAppInstalled"),
	)
	.middleware(Session) {}

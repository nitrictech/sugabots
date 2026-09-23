import {
	connectFromCatalogSchema,
	connectionUpdateSchema,
	newConnectionSchema,
} from "@sugabots/contracts";
import type { listServerTools } from "@sugabots/core/providers/connections/mcp";
import {
	beginAuthorization,
	finishAuthorization,
	type OAuthProviders,
	oauthProviders,
} from "@sugabots/core/providers/connections/oauth";
import {
	type ConnectionDoesNotUseOAuth,
	type ConnectionNeededNoSignIn,
	type ConnectionNotFound,
	type ConnectionOAuthStartFailed,
	type ConnectionUrlNotAllowed,
	connectionOperations,
} from "@sugabots/core/providers/connections/operations";
import type {
	ConnectionNameTaken,
	ConnectionStore,
} from "@sugabots/core/providers/connections/store";
import type {
	EgressHttpClient,
	EgressHttpClients,
	EgressUrlValidator,
} from "@sugabots/core/providers/network/egress";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { Hono } from "hono";
import { type AuthEnv, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { requirePod } from "../../http/authorisation.ts";
import { body } from "../../http/body.ts";
import { asHttpError, HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";

export interface ConnectionRoutesOptions {
	resolveSession: SessionResolver;
	authorization: Authorization;
	run: RunHandler;
	connections: ConnectionStore;
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
	listTools?: typeof listServerTools;
	oauth: {
		redirectUrl: string;
		fetch: EgressHttpClient;
		returnTo: string;
		begin?: typeof beginAuthorization;
		finish?: typeof finishAuthorization;
		providers?: OAuthProviders;
	};
}

export function createConnectionRoutes({
	resolveSession,
	authorization,
	run,
	connections,
	httpClients,
	validateProviderUrl,
	listTools,
	oauth,
}: ConnectionRoutesOptions) {
	const session = requireSession(resolveSession);
	const readsConnections = requirePod(authorization, run, "connection.read");
	const managesConnections = requirePod(authorization, run, "connection.manage");
	const root = "/pods/:podId/connections";
	const providers =
		oauth.providers ??
		oauthProviders({
			connections,
			run: (effect) => run(effect),
			redirectUrl: oauth.redirectUrl,
		});
	const operations = connectionOperations({
		connections,
		authorization,
		httpClients,
		validateProviderUrl,
		listTools,
		oauth: {
			providers,
			fetch: oauth.fetch,
			begin: oauth.begin ?? beginAuthorization,
			finish: oauth.finish ?? finishAuthorization,
		},
	});

	return new Hono<AuthEnv>()
		.get(root, session, readsConnections, async (c) => {
			const { pod } = c.get("pod");
			return c.json(await run(operations.list(pod.workspaceId, pod.id)));
		})
		.post(root, session, managesConnections, body(newConnectionSchema), async (c) => {
			const { pod } = c.get("pod");
			const created = await run(
				operations
					.create(pod.workspaceId, pod.id, c.get("session").user.id, c.req.valid("json"))
					.pipe(asHttpError(connectionErrors)),
			);
			return c.json(created, 201);
		})
		.get(`${root}/:connectionId`, session, readsConnections, async (c) =>
			c.json(
				await run(
					operations
						.get(c.get("pod").pod.workspaceId, c.get("pod").pod.id, c.req.param("connectionId"))
						.pipe(asHttpError(connectionErrors)),
				),
			),
		)
		.patch(
			`${root}/:connectionId`,
			session,
			managesConnections,
			body(connectionUpdateSchema),
			async (c) =>
				c.json(
					await run(
						operations
							.update(
								c.get("pod").pod.workspaceId,
								c.get("pod").pod.id,
								c.req.param("connectionId"),
								c.req.valid("json"),
							)
							.pipe(asHttpError(connectionErrors)),
					),
				),
		)
		.delete(`${root}/:connectionId`, session, managesConnections, async (c) => {
			await run(
				operations
					.remove(c.get("pod").pod.workspaceId, c.get("pod").pod.id, c.req.param("connectionId"))
					.pipe(asHttpError(connectionErrors)),
			);
			return c.body(null, 204);
		})
		.post(`${root}/:connectionId/test`, session, managesConnections, async (c) =>
			c.json(
				await run(
					operations
						.test(c.get("pod").pod.workspaceId, c.get("pod").pod.id, c.req.param("connectionId"))
						.pipe(asHttpError(connectionErrors)),
				),
			),
		)
		.post(
			`${root}/connect`,
			session,
			managesConnections,
			body(connectFromCatalogSchema),
			async (c) => {
				const { pod } = c.get("pod");
				const result = await run(
					operations
						.connectFromCatalog(
							pod.workspaceId,
							pod.id,
							c.get("session").user.id,
							c.req.valid("json"),
						)
						.pipe(asHttpError(connectionErrors)),
				);
				return c.json(result, 201);
			},
		)
		.post(`${root}/:connectionId/oauth/start`, session, managesConnections, async (c) =>
			c.json(
				await run(
					operations
						.startOAuth(
							c.get("pod").pod.workspaceId,
							c.get("pod").pod.id,
							c.req.param("connectionId"),
						)
						.pipe(asHttpError(connectionErrors)),
				),
			),
		)
		.get("/connections/oauth/callback", session, async (c) => {
			if (c.req.method === "HEAD") {
				return c.body(null, 405, { Allow: "GET" });
			}
			const { code, state, error, error_description: errorDescription } = c.req.query();
			const outcome = await run(
				operations
					.completeOAuth(c.get("session").user.id, {
						code,
						state,
						error,
						errorDescription,
					})
					.pipe(asHttpError(connectionErrors)),
			);
			const back = new URL(oauth.returnTo);
			if ("failed" in outcome) {
				back.searchParams.set("oauth_error", outcome.failed);
			} else {
				back.pathname = `${back.pathname.replace(/\/$/, "")}/${outcome.connected.podId}`;
				back.searchParams.set("connected", outcome.connected.connectionId);
			}
			return c.redirect(back.toString(), 302);
		});
}

const connectionErrors = {
	ConnectionNameTaken: (failure: ConnectionNameTaken) => new HttpError("conflict", failure.message),
	ConnectionNotFound: (failure: ConnectionNotFound) => new HttpError("not_found", failure.message),
	ConnectionUrlNotAllowed: (failure: ConnectionUrlNotAllowed) =>
		new HttpError("bad_request", failure.message),
	ConnectionOAuthStartFailed: (failure: ConnectionOAuthStartFailed) =>
		new HttpError("bad_request", failure.message),
	ConnectionDoesNotUseOAuth: (failure: ConnectionDoesNotUseOAuth) =>
		new HttpError("bad_request", failure.message),
	ConnectionNeededNoSignIn: (failure: ConnectionNeededNoSignIn) =>
		new HttpError("bad_request", failure.message),
};

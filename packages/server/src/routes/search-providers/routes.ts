import { newSearchProviderSchema, searchProviderUpdateSchema } from "@sugabots/contracts";
import type {
	EgressHttpClients,
	EgressUrlValidator,
} from "@sugabots/core/providers/network/egress";
import {
	type SearchProviderApiKeyRequired,
	type SearchProviderNotFound,
	type SearchProviderUrlNotAllowed,
	searchProviderOperations,
} from "@sugabots/core/providers/search-providers/operations";
import type { SearchProviderStore } from "@sugabots/core/providers/search-providers/store";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { Hono } from "hono";
import { type AuthEnv, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { requireWorkspace } from "../../http/authorisation.ts";
import { body } from "../../http/body.ts";
import { asHttpError, HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";

export interface SearchProviderRoutesOptions {
	resolveSession: SessionResolver;
	authorization: Authorization;
	run: RunHandler;
	searchProviders: SearchProviderStore;
	httpClients: EgressHttpClients;
	validateProviderUrl: EgressUrlValidator;
}

export function createSearchProviderRoutes({
	resolveSession,
	authorization,
	run,
	searchProviders,
	httpClients,
	validateProviderUrl,
}: SearchProviderRoutesOptions) {
	const session = requireSession(resolveSession);
	const managesProviders = requireWorkspace(authorization, run, "workspace.providers.manage");
	const root = "/workspaces/:workspaceId/search-provider";
	const operations = searchProviderOperations({
		providers: searchProviders,
		httpClients,
		validateProviderUrl,
	});

	return new Hono<AuthEnv>()
		.get(root, session, managesProviders, async (c) =>
			c.json(await run(operations.get(c.get("workspace").workspaceId))),
		)
		.put(root, session, managesProviders, body(newSearchProviderSchema), async (c) => {
			const provider = await run(
				operations
					.replace(c.get("workspace").workspaceId, c.get("session").user.id, c.req.valid("json"))
					.pipe(asHttpError(searchProviderErrors)),
			);
			return c.json(provider, 201);
		})
		.patch(root, session, managesProviders, body(searchProviderUpdateSchema), async (c) =>
			c.json(
				await run(
					operations
						.update(c.get("workspace").workspaceId, c.req.valid("json"))
						.pipe(asHttpError(searchProviderErrors)),
				),
			),
		)
		.delete(root, session, managesProviders, async (c) => {
			await run(
				operations.remove(c.get("workspace").workspaceId).pipe(asHttpError(searchProviderErrors)),
			);
			return c.body(null, 204);
		})
		.post(`${root}/test`, session, managesProviders, async (c) =>
			c.json(
				await run(
					operations.test(c.get("workspace").workspaceId).pipe(asHttpError(searchProviderErrors)),
				),
			),
		);
}

const searchProviderErrors = {
	SearchProviderNotFound: (failure: SearchProviderNotFound) =>
		new HttpError("not_found", failure.message),
	SearchProviderUrlNotAllowed: (failure: SearchProviderUrlNotAllowed) =>
		new HttpError("bad_request", failure.message),
	SearchProviderApiKeyRequired: (failure: SearchProviderApiKeyRequired) =>
		new HttpError("bad_request", failure.message),
};

import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { SandboxNetwork } from "@sugabots/core/sandboxes/sandbox-network";
import { SandboxProviderSetup } from "@sugabots/core/sandboxes/sandbox-provider-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const sandboxProviderRoutes = HttpApiBuilder.group(
	ServerApi,
	"sandboxProviders",
	(handlers) =>
		Effect.gen(function* () {
			const setup = yield* SandboxProviderSetup.Service;
			const network = yield* SandboxNetwork.Service;
			return handlers
				.handle("list", ({ params }) =>
					setup.list(params.workspace).pipe(asSessionUser, asHttpError(sandboxProviderErrors)),
				)
				.handle("access", ({ params }) =>
					setup.access(params.workspace).pipe(
						Effect.map((enabled) => ({ enabled })),
						asSessionUser,
						asHttpError(sandboxProviderErrors),
					),
				)
				.handle("create", ({ params, payload }) =>
					setup
						.create({ workspace: params.workspace, provider: payload })
						.pipe(asSessionUser, asHttpError(sandboxProviderErrors)),
				)
				.handle("update", ({ params, payload }) =>
					setup
						.update({
							workspace: params.workspace,
							providerId: params.providerId,
							changes: payload,
						})
						.pipe(asSessionUser, asHttpError(sandboxProviderErrors)),
				)
				.handle("remove", ({ params }) =>
					setup
						.remove({ workspace: params.workspace, providerId: params.providerId })
						.pipe(asSessionUser, asHttpError(sandboxProviderErrors)),
				)
				.handle("template", ({ params }) =>
					setup.templateStatus({ workspace: params.workspace, providerId: params.providerId }).pipe(
						Effect.map((state) => ({ state: state ?? null })),
						asSessionUser,
						asHttpError(sandboxProviderErrors),
					),
				)
				.handle("prepareTemplate", ({ params }) =>
					setup
						.prepareTemplate({ workspace: params.workspace, providerId: params.providerId })
						.pipe(
							Effect.map((state) => ({ state })),
							asSessionUser,
							asHttpError(sandboxProviderErrors),
						),
				)
				.handle("test", ({ params }) =>
					setup
						.test({ workspace: params.workspace, providerId: params.providerId })
						.pipe(asSessionUser, asHttpError(sandboxProviderErrors)),
				)
				.handle("network", ({ params }) =>
					network.settings(params.workspace).pipe(asSessionUser, asHttpError(refusals)),
				)
				.handle("addHost", ({ params, payload }) =>
					network
						.addHost({ workspace: params.workspace, host: payload.host })
						.pipe(asSessionUser, asHttpError(refusals)),
				)
				.handle("removeHost", ({ params }) =>
					network
						.removeHost({ workspace: params.workspace, host: params.host })
						.pipe(asSessionUser, asHttpError(refusals)),
				)
				.handle("blockHost", ({ params, payload }) =>
					network
						.blockHost({ workspace: params.workspace, host: payload.host })
						.pipe(asSessionUser, asHttpError(refusals)),
				)
				.handle("unblockHost", ({ params }) =>
					network
						.unblockHost({ workspace: params.workspace, host: params.host })
						.pipe(asSessionUser, asHttpError(refusals)),
				);
		}),
);

const sandboxProviderErrors = {
	...refusals,
	SandboxProviderNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	SandboxProviderIncomplete: BadRequest,
	SandboxProviderPresetFixed: BadRequest,
	SandboxesNotDestroyed: Conflict,
	NoTemplates: BadRequest,
	SandboxUnavailable: Conflict,
};

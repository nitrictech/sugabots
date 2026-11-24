import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ComputerNetwork } from "@sugabots/core/computers/computer-network";
import { ComputerProviderSetup } from "@sugabots/core/computers/computer-provider-setup";
import { ProjectComputerSetup } from "@sugabots/core/computers/project-computer-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asCurrentUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const computerProviderRoutes = HttpApiBuilder.group(
	ServerApi,
	"computerProviders",
	(handlers) =>
		Effect.gen(function* () {
			const setup = yield* ComputerProviderSetup.Service;
			const network = yield* ComputerNetwork.Service;
			const projectComputers = yield* ProjectComputerSetup.Service;
			return handlers
				.handle("list", ({ params }) =>
					setup.list(params.workspace).pipe(asCurrentUser, asHttpError(computerProviderErrors)),
				)
				.handle("access", ({ params }) =>
					setup.access(params.workspace).pipe(
						Effect.map((enabled) => ({ enabled })),
						asCurrentUser,
						asHttpError(computerProviderErrors),
					),
				)
				.handle("create", ({ params, payload }) =>
					setup
						.create({ workspace: params.workspace, provider: payload })
						.pipe(asCurrentUser, asHttpError(computerProviderErrors)),
				)
				.handle("update", ({ params, payload }) =>
					setup
						.update({
							workspace: params.workspace,
							providerId: params.providerId,
							changes: payload,
						})
						.pipe(asCurrentUser, asHttpError(computerProviderErrors)),
				)
				.handle("remove", ({ params }) =>
					setup
						.remove({ workspace: params.workspace, providerId: params.providerId })
						.pipe(asCurrentUser, asHttpError(computerProviderErrors)),
				)
				.handle("template", ({ params }) =>
					setup.templateStatus({ workspace: params.workspace, providerId: params.providerId }).pipe(
						Effect.map((state) => ({ state: state ?? null })),
						asCurrentUser,
						asHttpError(computerProviderErrors),
					),
				)
				.handle("prepareTemplate", ({ params }) =>
					setup
						.prepareTemplate({ workspace: params.workspace, providerId: params.providerId })
						.pipe(
							Effect.map((state) => ({ state })),
							asCurrentUser,
							asHttpError(computerProviderErrors),
						),
				)
				.handle("test", ({ params }) =>
					setup
						.test({ workspace: params.workspace, providerId: params.providerId })
						.pipe(asCurrentUser, asHttpError(computerProviderErrors)),
				)
				.handle("disks", ({ params }) =>
					projectComputers.disks(params.workspace).pipe(asCurrentUser, asHttpError(refusals)),
				)
				.handle("network", ({ params }) =>
					network.settings(params.workspace).pipe(asCurrentUser, asHttpError(refusals)),
				)
				.handle("addHost", ({ params, payload }) =>
					network
						.addHost({ workspace: params.workspace, host: payload.host })
						.pipe(asCurrentUser, asHttpError(refusals)),
				)
				.handle("removeHost", ({ params }) =>
					network
						.removeHost({ workspace: params.workspace, host: params.host })
						.pipe(asCurrentUser, asHttpError(refusals)),
				)
				.handle("blockHost", ({ params, payload }) =>
					network
						.blockHost({ workspace: params.workspace, host: payload.host })
						.pipe(asCurrentUser, asHttpError(refusals)),
				)
				.handle("unblockHost", ({ params }) =>
					network
						.unblockHost({ workspace: params.workspace, host: params.host })
						.pipe(asCurrentUser, asHttpError(refusals)),
				);
		}),
);

const computerProviderErrors = {
	...refusals,
	ComputerProviderNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	ComputerProviderIncomplete: BadRequest,
	ComputerProviderBuiltInFixed: BadRequest,
	ComputersNotDestroyed: Conflict,
	ComputerMadeMeanwhile: Conflict,
	NoTemplates: BadRequest,
	ComputerUnavailable: Conflict,
};

import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ComputerNetwork } from "@sugabots/core/computers/computer-network";
import { ComputerProviderSetup } from "@sugabots/core/computers/computer-provider-setup";
import { ProjectComputerSetup } from "@sugabots/core/computers/project-computer-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSignedInPerson } from "../../auth/middleware.ts";
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
					setup.list(params.workspace).pipe(asSignedInPerson, asHttpError(computerProviderErrors)),
				)
				.handle("access", ({ params }) =>
					setup.access(params.workspace).pipe(
						Effect.map((enabled) => ({ enabled })),
						asSignedInPerson,
						asHttpError(computerProviderErrors),
					),
				)
				.handle("create", ({ params, payload }) =>
					setup
						.create({ workspace: params.workspace, provider: payload })
						.pipe(asSignedInPerson, asHttpError(computerProviderErrors)),
				)
				.handle("update", ({ params, payload }) =>
					setup
						.update({
							workspace: params.workspace,
							providerId: params.providerId,
							changes: payload,
						})
						.pipe(asSignedInPerson, asHttpError(computerProviderErrors)),
				)
				.handle("remove", ({ params }) =>
					setup
						.remove({ workspace: params.workspace, providerId: params.providerId })
						.pipe(asSignedInPerson, asHttpError(computerProviderErrors)),
				)
				.handle("template", ({ params }) =>
					setup.templateStatus({ workspace: params.workspace, providerId: params.providerId }).pipe(
						Effect.map((state) => ({ state: state ?? null })),
						asSignedInPerson,
						asHttpError(computerProviderErrors),
					),
				)
				.handle("prepareTemplate", ({ params }) =>
					setup
						.prepareTemplate({ workspace: params.workspace, providerId: params.providerId })
						.pipe(
							Effect.map((state) => ({ state })),
							asSignedInPerson,
							asHttpError(computerProviderErrors),
						),
				)
				.handle("test", ({ params }) =>
					setup
						.test({ workspace: params.workspace, providerId: params.providerId })
						.pipe(asSignedInPerson, asHttpError(computerProviderErrors)),
				)
				.handle("disks", ({ params }) =>
					projectComputers.disks(params.workspace).pipe(asSignedInPerson, asHttpError(refusals)),
				)
				.handle("network", ({ params }) =>
					network.settings(params.workspace).pipe(asSignedInPerson, asHttpError(refusals)),
				)
				.handle("addHost", ({ params, payload }) =>
					network
						.addHost({ workspace: params.workspace, host: payload.host })
						.pipe(asSignedInPerson, asHttpError(refusals)),
				)
				.handle("removeHost", ({ params }) =>
					network
						.removeHost({ workspace: params.workspace, host: params.host })
						.pipe(asSignedInPerson, asHttpError(refusals)),
				)
				.handle("blockHost", ({ params, payload }) =>
					network
						.blockHost({ workspace: params.workspace, host: payload.host })
						.pipe(asSignedInPerson, asHttpError(refusals)),
				)
				.handle("unblockHost", ({ params }) =>
					network
						.unblockHost({ workspace: params.workspace, host: params.host })
						.pipe(asSignedInPerson, asHttpError(refusals)),
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

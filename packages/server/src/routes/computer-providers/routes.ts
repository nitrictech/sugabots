import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { BotComputerSetup } from "@sugabots/core/computers/bot-computer-setup";
import { ComputerNetwork } from "@sugabots/core/computers/computer-network";
import { ComputerProviderSetup } from "@sugabots/core/computers/computer-provider-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const computerProviderRoutes = HttpApiBuilder.group(
	ServerApi,
	"computerProviders",
	(handlers) =>
		Effect.gen(function* () {
			const setup = yield* ComputerProviderSetup.Service;
			const network = yield* ComputerNetwork.Service;
			const botComputers = yield* BotComputerSetup.Service;
			return handlers
				.handle("list", ({ params }) =>
					setup.list(params.workspace).pipe(asSessionUser, asHttpError(computerProviderErrors)),
				)
				.handle("access", ({ params }) =>
					setup.access(params.workspace).pipe(
						Effect.map((enabled) => ({ enabled })),
						asSessionUser,
						asHttpError(computerProviderErrors),
					),
				)
				.handle("create", ({ params, payload }) =>
					setup
						.create({ workspace: params.workspace, provider: payload })
						.pipe(asSessionUser, asHttpError(computerProviderErrors)),
				)
				.handle("update", ({ params, payload }) =>
					setup
						.update({
							workspace: params.workspace,
							providerId: params.providerId,
							changes: payload,
						})
						.pipe(asSessionUser, asHttpError(computerProviderErrors)),
				)
				.handle("remove", ({ params }) =>
					setup
						.remove({ workspace: params.workspace, providerId: params.providerId })
						.pipe(asSessionUser, asHttpError(computerProviderErrors)),
				)
				.handle("template", ({ params }) =>
					setup.templateStatus({ workspace: params.workspace, providerId: params.providerId }).pipe(
						Effect.map((state) => ({ state: state ?? null })),
						asSessionUser,
						asHttpError(computerProviderErrors),
					),
				)
				.handle("prepareTemplate", ({ params }) =>
					setup
						.prepareTemplate({ workspace: params.workspace, providerId: params.providerId })
						.pipe(
							Effect.map((state) => ({ state })),
							asSessionUser,
							asHttpError(computerProviderErrors),
						),
				)
				.handle("test", ({ params }) =>
					setup
						.test({ workspace: params.workspace, providerId: params.providerId })
						.pipe(asSessionUser, asHttpError(computerProviderErrors)),
				)
				.handle("disks", ({ params }) =>
					botComputers.disks(params.workspace).pipe(asSessionUser, asHttpError(refusals)),
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

const computerProviderErrors = {
	...refusals,
	ComputerProviderNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	ComputerProviderIncomplete: BadRequest,
	ComputerProviderPresetFixed: BadRequest,
	ComputersNotDestroyed: Conflict,
	NoTemplates: BadRequest,
	ComputerUnavailable: Conflict,
};

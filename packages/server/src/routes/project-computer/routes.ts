import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ComputerNetwork } from "@sugabots/core/computers/computer-network";
import { ProjectComputerSetup } from "@sugabots/core/computers/project-computer-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asCurrentUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const projectComputerRoutes = HttpApiBuilder.group(
	ServerApi,
	"projectComputer",
	(handlers) =>
		Effect.gen(function* () {
			const setup = yield* ProjectComputerSetup.Service;
			const network = yield* ComputerNetwork.Service;
			return handlers
				.handle("get", ({ params }) =>
					setup.get(params.projectId).pipe(asCurrentUser, asHttpError(projectComputerErrors)),
				)
				.handle("reset", ({ params }) =>
					setup.reset(params.projectId).pipe(asCurrentUser, asHttpError(projectComputerErrors)),
				)
				.handle("upgrade", ({ params }) =>
					setup.upgrade(params.projectId).pipe(asCurrentUser, asHttpError(projectComputerErrors)),
				)
				.handle("network", ({ params }) =>
					network.projectSettings(params.projectId).pipe(asCurrentUser, asHttpError(refusals)),
				)
				.handle("addHost", ({ params, payload }) =>
					network
						.addProjectHost({ projectId: params.projectId, host: payload.host })
						.pipe(asCurrentUser, asHttpError({ ...refusals, ComputerHostBlocked: BadRequest })),
				)
				.handle("removeHost", ({ params }) =>
					network
						.removeProjectHost({ projectId: params.projectId, host: params.host })
						.pipe(asCurrentUser, asHttpError(refusals)),
				);
		}),
);

const projectComputerErrors = {
	...refusals,
	ComputerInUse: Conflict,
	NoComputer: NotFound,
	UpgradeFailed: Conflict,
	NoComputerProvider: BadRequest,
	ComputerUnavailable: Conflict,
};

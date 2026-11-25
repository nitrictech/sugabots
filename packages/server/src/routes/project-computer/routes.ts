import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** A project's computer and the hosts it may reach, each endpoint its operation. */
export const projectComputerRoutes = HttpApiBuilder.group(
	ServerApi,
	"projectComputer",
	(handlers) =>
		Effect.map(operationCaller, (callOperation) =>
			handlers
				.handle("get", ({ params }) =>
					callOperation("projectComputer.get", { projectId: params.projectId }).pipe(
						asHttpError(projectComputerErrors),
					),
				)
				.handle("reset", ({ params }) =>
					callOperation("projectComputer.reset", { projectId: params.projectId }).pipe(
						asHttpError(projectComputerErrors),
					),
				)
				.handle("upgrade", ({ params }) =>
					callOperation("projectComputer.upgrade", { projectId: params.projectId }).pipe(
						asHttpError(projectComputerErrors),
					),
				)
				.handle("network", ({ params }) =>
					callOperation("projectComputer.network", { projectId: params.projectId }).pipe(
						asHttpError(projectComputerErrors),
					),
				)
				.handle("addHost", ({ params, payload }) =>
					callOperation("projectComputer.addHost", {
						projectId: params.projectId,
						host: payload.host,
					}).pipe(asHttpError(projectComputerErrors)),
				)
				.handle("removeHost", ({ params }) =>
					callOperation("projectComputer.removeHost", {
						projectId: params.projectId,
						host: params.host,
					}).pipe(asHttpError(projectComputerErrors)),
				),
		),
);

/** What each way a project computer operation can fail means over HTTP. */
const projectComputerErrors = {
	...refusals,
	ClaimLost: Conflict,
	ComputerInUse: Conflict,
	NoComputer: NotFound,
	UpgradeFailed: Conflict,
	NoComputerProvider: BadRequest,
	ComputerUnavailable: Conflict,
	ComputerHostBlocked: BadRequest,
};

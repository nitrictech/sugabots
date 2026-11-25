import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/**
 * Where a workspace's computers run, how full their disks are, and which
 * hosts they may reach, each endpoint its operation.
 */
export const computerProviderRoutes = HttpApiBuilder.group(
	ServerApi,
	"computerProviders",
	(handlers) =>
		Effect.map(operationCaller, (callOperation) =>
			handlers
				.handle("list", ({ params }) =>
					callOperation("computerProviders.list", { workspace: params.workspace }).pipe(
						asHttpError(computerProviderErrors),
					),
				)
				.handle("access", ({ params }) =>
					callOperation("computerProviders.access", { workspace: params.workspace }).pipe(
						asHttpError(computerProviderErrors),
					),
				)
				.handle("create", ({ params, payload }) =>
					callOperation("computerProviders.create", {
						workspace: params.workspace,
						...payload,
					}).pipe(asHttpError(computerProviderErrors)),
				)
				.handle("update", ({ params, payload }) =>
					callOperation("computerProviders.update", {
						workspace: params.workspace,
						providerId: params.providerId,
						changes: payload,
					}).pipe(asHttpError(computerProviderErrors)),
				)
				.handle("remove", ({ params }) =>
					callOperation("computerProviders.remove", {
						workspace: params.workspace,
						providerId: params.providerId,
					}).pipe(asHttpError(computerProviderErrors)),
				)
				.handle("template", ({ params }) =>
					callOperation("computerProviders.template", {
						workspace: params.workspace,
						providerId: params.providerId,
					}).pipe(asHttpError(computerProviderErrors)),
				)
				.handle("prepareTemplate", ({ params }) =>
					callOperation("computerProviders.prepareTemplate", {
						workspace: params.workspace,
						providerId: params.providerId,
					}).pipe(asHttpError(computerProviderErrors)),
				)
				.handle("test", ({ params }) =>
					callOperation("computerProviders.test", {
						workspace: params.workspace,
						providerId: params.providerId,
					}).pipe(asHttpError(computerProviderErrors)),
				)
				.handle("disks", ({ params }) =>
					callOperation("computerProviders.disks", { workspace: params.workspace }).pipe(
						asHttpError(computerProviderErrors),
					),
				)
				.handle("network", ({ params }) =>
					callOperation("computerProviders.network", { workspace: params.workspace }).pipe(
						asHttpError(computerProviderErrors),
					),
				)
				.handle("addHost", ({ params, payload }) =>
					callOperation("computerProviders.addHost", {
						workspace: params.workspace,
						host: payload.host,
					}).pipe(asHttpError(computerProviderErrors)),
				)
				.handle("removeHost", ({ params }) =>
					callOperation("computerProviders.removeHost", {
						workspace: params.workspace,
						host: params.host,
					}).pipe(asHttpError(computerProviderErrors)),
				)
				.handle("blockHost", ({ params, payload }) =>
					callOperation("computerProviders.blockHost", {
						workspace: params.workspace,
						host: payload.host,
					}).pipe(asHttpError(computerProviderErrors)),
				)
				.handle("unblockHost", ({ params }) =>
					callOperation("computerProviders.unblockHost", {
						workspace: params.workspace,
						host: params.host,
					}).pipe(asHttpError(computerProviderErrors)),
				),
		),
);

/** What each way a computer providers operation can fail means over HTTP. */
const computerProviderErrors = {
	...refusals,
	ComputerProviderNotFound: NotFound,
	UrlNotAllowed: BadRequest,
	ComputerProviderIncomplete: BadRequest,
	ComputerProviderBuiltInFixed: BadRequest,
	ComputerProviderHasComputers: Conflict,
	ComputersNotDestroyed: Conflict,
	ComputerMadeMeanwhile: Conflict,
	NoTemplates: BadRequest,
	ComputerUnavailable: Conflict,
};

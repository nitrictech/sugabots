import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { PodSandboxSetup } from "@sugabots/core/sandboxes/pod-sandbox-setup";
import { SandboxNetwork } from "@sugabots/core/sandboxes/sandbox-network";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const podSandboxRoutes = HttpApiBuilder.group(ServerApi, "podSandbox", (handlers) =>
	Effect.gen(function* () {
		const setup = yield* PodSandboxSetup.Service;
		const network = yield* SandboxNetwork.Service;
		return handlers
			.handle("get", ({ params }) =>
				setup.get(params.podId).pipe(asSessionUser, asHttpError(podSandboxErrors)),
			)
			.handle("reset", ({ params }) =>
				setup.reset(params.podId).pipe(asSessionUser, asHttpError(podSandboxErrors)),
			)
			.handle("upgrade", ({ params }) =>
				setup.upgrade(params.podId).pipe(asSessionUser, asHttpError(podSandboxErrors)),
			)
			.handle("network", ({ params }) =>
				network.podSettings(params.podId).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("addHost", ({ params, payload }) =>
				network
					.addPodHost({ podId: params.podId, host: payload.host })
					.pipe(asSessionUser, asHttpError({ ...refusals, SandboxHostBlocked: BadRequest })),
			)
			.handle("removeHost", ({ params }) =>
				network
					.removePodHost({ podId: params.podId, host: params.host })
					.pipe(asSessionUser, asHttpError(refusals)),
			);
	}),
);

const podSandboxErrors = {
	...refusals,
	SandboxInUse: Conflict,
	NoSandbox: NotFound,
	UpgradeFailed: Conflict,
	NoSandboxProvider: BadRequest,
	SandboxUnavailable: Conflict,
};

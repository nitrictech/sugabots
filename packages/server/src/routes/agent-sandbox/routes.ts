import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { AgentSandboxSetup } from "@sugabots/core/sandboxes/agent-sandbox-setup";
import { SandboxNetwork } from "@sugabots/core/sandboxes/sandbox-network";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const agentSandboxRoutes = HttpApiBuilder.group(ServerApi, "agentSandbox", (handlers) =>
	Effect.gen(function* () {
		const setup = yield* AgentSandboxSetup.Service;
		const network = yield* SandboxNetwork.Service;
		return handlers
			.handle("get", ({ params }) =>
				setup.get(params.agentId).pipe(asSessionUser, asHttpError(agentSandboxErrors)),
			)
			.handle("reset", ({ params }) =>
				setup.reset(params.agentId).pipe(asSessionUser, asHttpError(agentSandboxErrors)),
			)
			.handle("upgrade", ({ params }) =>
				setup.upgrade(params.agentId).pipe(asSessionUser, asHttpError(agentSandboxErrors)),
			)
			.handle("network", ({ params }) =>
				network.agentSettings(params.agentId).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("addHost", ({ params, payload }) =>
				network
					.addAgentHost({ agentId: params.agentId, host: payload.host })
					.pipe(asSessionUser, asHttpError({ ...refusals, SandboxHostBlocked: BadRequest })),
			)
			.handle("removeHost", ({ params }) =>
				network
					.removeAgentHost({ agentId: params.agentId, host: params.host })
					.pipe(asSessionUser, asHttpError(refusals)),
			);
	}),
);

const agentSandboxErrors = {
	...refusals,
	SandboxInUse: Conflict,
	NoSandbox: NotFound,
	UpgradeFailed: Conflict,
	NoSandboxProvider: BadRequest,
	SandboxUnavailable: Conflict,
};

import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { BotComputerSetup } from "@sugabots/core/computers/bot-computer-setup";
import { ComputerNetwork } from "@sugabots/core/computers/computer-network";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const botComputerRoutes = HttpApiBuilder.group(ServerApi, "botComputer", (handlers) =>
	Effect.gen(function* () {
		const setup = yield* BotComputerSetup.Service;
		const network = yield* ComputerNetwork.Service;
		return handlers
			.handle("get", ({ params }) =>
				setup.get(params.botId).pipe(asSessionUser, asHttpError(botComputerErrors)),
			)
			.handle("reset", ({ params }) =>
				setup.reset(params.botId).pipe(asSessionUser, asHttpError(botComputerErrors)),
			)
			.handle("upgrade", ({ params }) =>
				setup.upgrade(params.botId).pipe(asSessionUser, asHttpError(botComputerErrors)),
			)
			.handle("network", ({ params }) =>
				network.botSettings(params.botId).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("addHost", ({ params, payload }) =>
				network
					.addBotHost({ botId: params.botId, host: payload.host })
					.pipe(asSessionUser, asHttpError({ ...refusals, ComputerHostBlocked: BadRequest })),
			)
			.handle("removeHost", ({ params }) =>
				network
					.removeBotHost({ botId: params.botId, host: params.host })
					.pipe(asSessionUser, asHttpError(refusals)),
			);
	}),
);

const botComputerErrors = {
	...refusals,
	ComputerInUse: Conflict,
	NoComputer: NotFound,
	UpgradeFailed: Conflict,
	NoComputerProvider: BadRequest,
	ComputerUnavailable: Conflict,
};

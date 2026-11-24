import { systemBotKeySchema } from "@sugabots/contracts";
import { BadRequest, NotFound } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/**
 * The workspace's system bots, addressed by key, each endpoint its operation.
 * `SystemBotsApi` says why reading them is open to the whole workspace.
 */
export const systemBotRoutes = HttpApiBuilder.group(ServerApi, "systemBots", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers
			.handle("list", ({ params }) =>
				callOperation("systemBots.list", { workspace: params.workspace }).pipe(
					asHttpError(systemBotErrors),
				),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const key = Schema.decodeUnknownOption(systemBotKeySchema)(params.key);
					if (key._tag === "None") {
						return yield* new NotFound({ message: userText`No such system bot` });
					}
					return yield* callOperation("systemBots.update", {
						workspace: params.workspace,
						key: key.value,
						model: payload.model,
					}).pipe(asHttpError(systemBotErrors));
				}),
			),
	),
);

/** What each way a system bots operation can fail means over HTTP. */
const systemBotErrors = {
	...refusals,
	ModelNotEnabled: BadRequest,
	SystemBotMissing: NotFound,
};

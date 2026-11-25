import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** A workspace's bots, and each member's Personal Assistant, each endpoint its operation. */
export const botRoutes = HttpApiBuilder.group(ServerApi, "bots", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers
			.handle("list", ({ params }) =>
				callOperation("bots.list", { workspace: params.workspace }).pipe(asHttpError(botErrors)),
			)
			.handle("create", ({ params, payload }) =>
				callOperation("bots.create", { workspace: params.workspace, ...payload }).pipe(
					asHttpError(botErrors),
				),
			)
			.handle("update", ({ params, payload }) =>
				callOperation("bots.update", { botId: params.botId, changes: payload }).pipe(
					asHttpError(botErrors),
				),
			)
			.handle("remove", ({ params }) =>
				callOperation("bots.remove", { botId: params.botId }).pipe(asHttpError(botErrors)),
			)
			.handle("pin", ({ params }) =>
				callOperation("bots.pin", { botId: params.botId }).pipe(
					Effect.catchTags(botCallRefusals),
					asHttpError(botErrors),
				),
			)
			.handle("unpin", ({ params }) =>
				callOperation("bots.unpin", { botId: params.botId }).pipe(
					Effect.catchTags(botCallRefusals),
					asHttpError(botErrors),
				),
			)
			.handle("ensureAssistant", ({ params, payload }) =>
				callOperation("bots.ensureAssistant", {
					workspace: params.workspace,
					model: payload.model,
				}).pipe(asHttpError(botErrors)),
			),
	),
);

/** What each way a bots operation can fail means over HTTP. */
const botErrors = {
	...refusals,
	ModelNotEnabled: BadRequest,
	EmptyBotUpdate: BadRequest,
	BotNameTaken: Conflict,
	BotHandleReserved: BadRequest,
	BotGone: NotFound,
	SystemBotImmutable: BadRequest,
	AssistantVisibilityFixed: BadRequest,
	AssistantInstructionsManaged: BadRequest,
	AssistantManaged: BadRequest,
	ComputerUnavailable: Conflict,
	ComputerMadeMeanwhile: Conflict,
	ClaimLost: Conflict,
	LeadsProjects: Conflict,
};

/**
 * How the operation refuses a bot's call, waiting for approval or outside
 * its turn, which a member signed in never meets.
 */
const botCallRefusals = {
	ApprovalNeeded: Effect.die,
	ApprovalRefused: Effect.die,
	TurnEnded: Effect.die,
	TurnExecutionSuperseded: Effect.die,
};

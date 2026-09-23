import { sValidator } from "@hono/standard-validator";
import {
	MAX_IDEMPOTENCY_KEY_CHARACTERS,
	manualRoutineRunSchema,
	newRoutineSchema,
	routineExecutionPageQuerySchema,
	routineSchedulePreviewSchema,
	routineUpdateSchema,
} from "@sugabots/contracts";
import type { InvalidRoutineSchedule } from "@sugabots/core/conversations/routines/schedule";
import { upcomingOccurrences } from "@sugabots/core/conversations/routines/schedule";
import type {
	InvalidRoutineExecutionCursor,
	RoutineNameTaken,
	RoutineNotFound,
	RoutineRequiresCrewAgent,
	RoutineStore,
	RoutineTriggerConflict,
	RoutineTriggerRejected,
} from "@sugabots/core/conversations/routines/store";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { Schema } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import { type AuthEnv, bearerToken, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { requireAgent } from "../../http/authorisation.ts";
import { body } from "../../http/body.ts";
import { asHttpError, HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";

export interface RoutineRoutesOptions {
	resolveSession: SessionResolver;
	authorization: Authorization;
	run: RunHandler;
	routines: RoutineStore;
}

export function createRoutineRoutes({
	resolveSession,
	authorization,
	run,
	routines,
}: RoutineRoutesOptions) {
	const session = requireSession(resolveSession);
	const readsRoutines = requireAgent(authorization, run, "routine.read");
	const managesRoutines = requireAgent(authorization, run, "routine.manage");
	const runsRoutines = requireAgent(authorization, run, "routine.run");
	const readsHistory = requireAgent(authorization, run, "routine.history.read");
	const executionPage = sValidator(
		"query",
		Schema.toStandardSchemaV1(routineExecutionPageQuerySchema),
		(result) => {
			if (!result.success) {
				throw new HttpError(
					"bad_request",
					"That is not a valid Routine execution page",
					result.error,
				);
			}
		},
	);

	return new Hono<AuthEnv>()
		.get("/agents/:agentId/routines", session, readsRoutines, async (c) => {
			const { agent } = c.get("agent");
			return c.json(await run(routines.list(agent.workspaceId, agent.id)));
		})
		.post(
			"/agents/:agentId/routines",
			session,
			managesRoutines,
			body(newRoutineSchema),
			async (c) => {
				const { agent } = c.get("agent");
				const result = await run(
					routines
						.create(agent.workspaceId, agent.id, c.get("session").user.id, c.req.valid("json"))
						.pipe(asHttpError(routineErrors)),
				);
				return c.json(result, 201);
			},
		)
		.post(
			"/agents/:agentId/routines/schedule-preview",
			session,
			managesRoutines,
			body(routineSchedulePreviewSchema),
			async (c) => {
				const input = c.req.valid("json");
				const dates = await run(
					upcomingOccurrences(input.expression, input.timezone).pipe(asHttpError(scheduleErrors)),
				);
				return c.json(dates.map((date) => date.toISOString()));
			},
		)
		.get("/agents/:agentId/routines/:routineId", session, readsRoutines, async (c) => {
			const { agent } = c.get("agent");
			const found = await run(routines.get(agent.workspaceId, agent.id, c.req.param("routineId")));
			if (!found) throw new HttpError("not_found", "No such Routine");
			return c.json(found);
		})
		.patch(
			"/agents/:agentId/routines/:routineId",
			session,
			managesRoutines,
			body(routineUpdateSchema),
			async (c) => {
				const { agent } = c.get("agent");
				return c.json(
					await run(
						routines
							.update(agent.workspaceId, agent.id, c.req.param("routineId"), c.req.valid("json"))
							.pipe(asHttpError(routineErrors)),
					),
				);
			},
		)
		.delete("/agents/:agentId/routines/:routineId", session, managesRoutines, async (c) => {
			const { agent } = c.get("agent");
			await run(
				routines
					.remove(agent.workspaceId, agent.id, c.req.param("routineId"))
					.pipe(asHttpError(routineErrors)),
			);
			return c.body(null, 204);
		})
		.post(
			"/agents/:agentId/routines/:routineId/run",
			session,
			runsRoutines,
			body(manualRoutineRunSchema),
			async (c) => {
				const { agent } = c.get("agent");
				const request = c.req.valid("json");
				const result = await run(
					routines
						.acceptTrigger({
							workspaceId: agent.workspaceId,
							agentId: agent.id,
							routineId: c.req.param("routineId"),
							triggerIdentity: request.requestId,
							trigger: {
								kind: "manual",
								requestId: request.requestId,
								requestedAt: new Date().toISOString(),
								requestedByUserId: c.get("session").user.id,
							},
						})
						.pipe(asHttpError(routineErrors)),
				);
				return c.json(result, 202);
			},
		)
		.post("/agents/:agentId/routines/:routineId/secret", session, managesRoutines, async (c) => {
			const { agent } = c.get("agent");
			const secret = await run(
				routines
					.rotateSecret(agent.workspaceId, agent.id, c.req.param("routineId"))
					.pipe(asHttpError(routineErrors)),
			);
			return c.json({ secret });
		})
		.get(
			"/agents/:agentId/routines/:routineId/executions",
			session,
			readsHistory,
			executionPage,
			async (c) => {
				const { agent } = c.get("agent");
				const executions = await run(
					routines
						.listExecutions(
							agent.workspaceId,
							agent.id,
							c.req.param("routineId"),
							c.req.valid("query"),
						)
						.pipe(asHttpError(routineErrors)),
				);
				if (!executions) throw new HttpError("not_found", "No such Routine");
				return c.json(executions);
			},
		)
		.post("/hooks/routines/:routineId", requireJsonContent, body(Schema.Json), async (c) => {
			const secret = bearerToken(c.req.header("authorization"));
			const idempotencyKey = c.req.header("idempotency-key")?.trim() || null;
			if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARACTERS) {
				throw new HttpError("bad_request", "Idempotency-Key is too long");
			}
			const result = secret
				? await run(
						routines
							.acceptWebhook(c.req.param("routineId"), secret, {
								kind: "webhook",
								idempotencyKey,
								payload: c.req.valid("json"),
								receivedAt: new Date().toISOString(),
							})
							.pipe(asHttpError(routineErrors)),
					)
				: undefined;
			if (!result) throw new HttpError("unauthorized", "Invalid Routine webhook credentials");
			return c.json({ executionId: result.executionId, duplicate: result.duplicate }, 202);
		});
}

const requireJsonContent: MiddlewareHandler<AuthEnv> = async (c, next) => {
	const mediaType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType !== "application/json" && !mediaType?.endsWith("+json")) {
		throw new HttpError("bad_request", "Routine webhooks require a JSON content type");
	}
	await next();
};

const scheduleErrors = {
	InvalidRoutineSchedule: (failure: InvalidRoutineSchedule) =>
		new HttpError("bad_request", failure.message),
};

const routineErrors = {
	InvalidRoutineExecutionCursor: (_failure: InvalidRoutineExecutionCursor) =>
		new HttpError("bad_request", "That Routine execution cursor is invalid"),
	InvalidRoutineSchedule: (failure: InvalidRoutineSchedule) =>
		new HttpError("bad_request", failure.message),
	RoutineNameTaken: (_failure: RoutineNameTaken) =>
		new HttpError("conflict", "A Routine with that name already exists"),
	RoutineNotFound: (_failure: RoutineNotFound) => new HttpError("not_found", "No such Routine"),
	RoutineRequiresCrewAgent: (_failure: RoutineRequiresCrewAgent) =>
		new HttpError("bad_request", "Only crew agents can own Routines"),
	RoutineTriggerConflict: (_failure: RoutineTriggerConflict) =>
		new HttpError("conflict", "That trigger identity was already used with different data"),
	RoutineTriggerRejected: (_failure: RoutineTriggerRejected) =>
		new HttpError("bad_request", "That Routine cannot accept this trigger"),
};

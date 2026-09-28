import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	acceptedRoutineExecutionSchema,
	acceptedRoutineWebhookSchema,
	manualRoutineRunSchema,
	newRoutineSchema,
	routineExecutionPageQuerySchema,
	routineExecutionPageSchema,
	routineScheduleOccurrencesSchema,
	routineSchedulePreviewSchema,
	routineSchema,
	routineSecretSchema,
	routineUpdateSchema,
	routineWriteResultSchema,
	workspaceRoutineListSchema,
} from "../../routines.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused, Unauthorized } from "../errors.ts";
import { Session } from "../middleware.ts";

const agent = { agentId: uuidSchema };
const routine = { agentId: uuidSchema, routineId: Schema.String };

/**
 * The webhook is the one endpoint here without a session: it is called by
 * other systems holding the Routine's secret, so `Session` is on each of the
 * others rather than on the group.
 */
export class RoutinesApi extends HttpApiGroup.make("routines").add(
	HttpApiEndpoint.get("listInWorkspace", "/workspaces/:workspace/routines", {
		params: { workspace: workspaceIdOrSlugSchema },
		success: workspaceRoutineListSchema,
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.get("list", "/agents/:agentId/routines", {
		params: agent,
		success: Schema.Array(routineSchema),
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.post("create", "/agents/:agentId/routines", {
		params: agent,
		payload: newRoutineSchema,
		success: routineWriteResultSchema.pipe(HttpApiSchema.status(201)),
		error: [Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.post("previewSchedule", "/agents/:agentId/routines/schedule-preview", {
		params: agent,
		payload: routineSchedulePreviewSchema,
		success: routineScheduleOccurrencesSchema,
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.get("get", "/agents/:agentId/routines/:routineId", {
		params: routine,
		success: routineSchema,
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.patch("update", "/agents/:agentId/routines/:routineId", {
		params: routine,
		payload: routineUpdateSchema,
		success: routineWriteResultSchema,
		error: [Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.delete("remove", "/agents/:agentId/routines/:routineId", {
		params: routine,
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.post("run", "/agents/:agentId/routines/:routineId/run", {
		params: routine,
		payload: manualRoutineRunSchema,
		success: acceptedRoutineExecutionSchema.pipe(HttpApiSchema.status(202)),
		error: [Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.post("rotateSecret", "/agents/:agentId/routines/:routineId/secret", {
		params: routine,
		success: routineSecretSchema,
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.get("executions", "/agents/:agentId/routines/:routineId/executions", {
		params: routine,
		query: routineExecutionPageQuerySchema,
		success: routineExecutionPageSchema,
		error: refused,
	}).middleware(Session),
	// Any JSON body, carried to the Routine as its trigger's payload. The
	// Routine's secret is the bearer token; `Idempotency-Key` makes a retry
	// land on the execution the first delivery started.
	HttpApiEndpoint.post("webhook", "/hooks/routines/:routineId", {
		params: { routineId: Schema.String },
		payload: Schema.Json,
		success: acceptedRoutineWebhookSchema.pipe(HttpApiSchema.status(202)),
		error: [BadRequest, Unauthorized, Conflict],
	}),
) {}

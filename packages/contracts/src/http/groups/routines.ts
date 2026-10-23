import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	acceptedRoutineExecutionSchema,
	acceptedRoutineWebhookSchema,
	ignoredRoutineWebhookSchema,
	manualRoutineRunSchema,
	newRoutineSchema,
	routineCurrentSecretSchema,
	routineExecutionPageQuerySchema,
	routineExecutionPageSchema,
	routineScheduleOccurrencesSchema,
	routineSchedulePreviewSchema,
	routineSchema,
	routineSecretReplacementSchema,
	routineSecretSchema,
	routineTriggerInputSchema,
	routineUpdateSchema,
	routineWebhookChallengeSchema,
	routineWriteResultSchema,
	workspaceRoutineListSchema,
} from "../../routines.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused, Unauthorized } from "../errors.ts";
import { Session } from "../middleware.ts";

const agent = { agentId: uuidSchema };
const routine = { agentId: uuidSchema, routineId: Schema.String };
const trigger = { ...routine, triggerId: uuidSchema };

/** A run queued, a call its trigger's filter turned away, or Slack's address check. */
const webhookAnswers = [
	acceptedRoutineWebhookSchema.pipe(HttpApiSchema.status(202)),
	ignoredRoutineWebhookSchema,
	routineWebhookChallengeSchema,
];

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
	HttpApiEndpoint.post("addTrigger", "/agents/:agentId/routines/:routineId/triggers", {
		params: routine,
		payload: routineTriggerInputSchema,
		success: routineWriteResultSchema.pipe(HttpApiSchema.status(201)),
		error: [BadRequest, Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.put("updateTrigger", "/agents/:agentId/routines/:routineId/triggers/:triggerId", {
		params: trigger,
		payload: routineTriggerInputSchema,
		success: routineWriteResultSchema,
		error: [BadRequest, Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.delete(
		"removeTrigger",
		"/agents/:agentId/routines/:routineId/triggers/:triggerId",
		{ params: trigger, success: routineSchema, error: [Conflict, ...refused] },
	).middleware(Session),
	HttpApiEndpoint.get(
		"getSecret",
		"/agents/:agentId/routines/:routineId/triggers/:triggerId/secret",
		{ params: trigger, success: routineCurrentSecretSchema, error: refused },
	).middleware(Session),
	HttpApiEndpoint.post(
		"rotateSecret",
		"/agents/:agentId/routines/:routineId/triggers/:triggerId/secret",
		{
			params: trigger,
			payload: routineSecretReplacementSchema,
			success: routineSecretSchema,
			error: refused,
		},
	).middleware(Session),
	HttpApiEndpoint.get("executions", "/agents/:agentId/routines/:routineId/executions", {
		params: routine,
		query: routineExecutionPageQuerySchema,
		success: routineExecutionPageSchema,
		error: refused,
	}).middleware(Session),
	// Any JSON body, carried to the routine as its trigger's payload. The
	// caller proves it holds the trigger's secret the way the trigger's auth
	// says. A delivery id, such as `Idempotency-Key`, makes a retry land on
	// the execution the first delivery started. Slack's URL check is answered
	// with its challenge, and starts nothing.
	HttpApiEndpoint.post("webhook", "/hooks/triggers/:triggerId", {
		params: { triggerId: Schema.String },
		payload: Schema.Json,
		success: webhookAnswers,
		error: [BadRequest, Unauthorized, Conflict],
	}),
	// The address a webhook had when a routine had only one trigger: a
	// trigger moved from then has its routine's id, so it is still reached here.
	HttpApiEndpoint.post("routineWebhook", "/hooks/routines/:routineId", {
		params: { routineId: Schema.String },
		payload: Schema.Json,
		success: webhookAnswers,
		error: [BadRequest, Unauthorized, Conflict],
	}),
) {}

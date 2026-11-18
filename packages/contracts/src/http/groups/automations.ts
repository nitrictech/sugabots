import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	acceptedAutomationWebhookSchema,
	acceptedRunSchema,
	automationCurrentSecretSchema,
	automationScheduleOccurrencesSchema,
	automationSchedulePreviewSchema,
	automationSchema,
	automationSecretReplacementSchema,
	automationSecretSchema,
	automationTriggerInputSchema,
	automationUpdateSchema,
	automationWebhookChallengeSchema,
	automationWriteResultSchema,
	ignoredAutomationWebhookSchema,
	manualAutomationRunSchema,
	newAutomationSchema,
	runPageQuerySchema,
	runPageSchema,
	workspaceAutomationListSchema,
} from "../../automations.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused, Unauthorized } from "../errors.ts";
import { Session } from "../middleware.ts";

const bot = { botId: uuidSchema };
const automation = { botId: uuidSchema, automationId: Schema.String };
const trigger = { ...automation, triggerId: uuidSchema };

/** A run queued, a call its trigger's filter turned away, or Slack's address check. */
const webhookAnswers = [
	acceptedAutomationWebhookSchema.pipe(HttpApiSchema.status(202)),
	ignoredAutomationWebhookSchema,
	automationWebhookChallengeSchema,
];

/**
 * The webhook is the one endpoint here without a session: it is called by
 * other systems holding the automation's secret, so `Session` is on each of the
 * others rather than on the group.
 */
export class AutomationsApi extends HttpApiGroup.make("automations").add(
	HttpApiEndpoint.get("listInWorkspace", "/workspaces/:workspace/automations", {
		params: { workspace: workspaceIdOrSlugSchema },
		success: workspaceAutomationListSchema,
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.get("list", "/bots/:botId/automations", {
		params: bot,
		success: Schema.Array(automationSchema),
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.post("create", "/bots/:botId/automations", {
		params: bot,
		payload: newAutomationSchema,
		success: automationWriteResultSchema.pipe(HttpApiSchema.status(201)),
		error: [Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.post("previewSchedule", "/bots/:botId/automations/schedule-preview", {
		params: bot,
		payload: automationSchedulePreviewSchema,
		success: automationScheduleOccurrencesSchema,
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.get("get", "/bots/:botId/automations/:automationId", {
		params: automation,
		success: automationSchema,
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.patch("update", "/bots/:botId/automations/:automationId", {
		params: automation,
		payload: automationUpdateSchema,
		success: automationWriteResultSchema,
		error: [Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.delete("remove", "/bots/:botId/automations/:automationId", {
		params: automation,
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.post("run", "/bots/:botId/automations/:automationId/run", {
		params: automation,
		payload: manualAutomationRunSchema,
		success: acceptedRunSchema.pipe(HttpApiSchema.status(202)),
		error: [Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.post("addTrigger", "/bots/:botId/automations/:automationId/triggers", {
		params: automation,
		payload: automationTriggerInputSchema,
		success: automationWriteResultSchema.pipe(HttpApiSchema.status(201)),
		error: [BadRequest, Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.put(
		"updateTrigger",
		"/bots/:botId/automations/:automationId/triggers/:triggerId",
		{
			params: trigger,
			payload: automationTriggerInputSchema,
			success: automationWriteResultSchema,
			error: [BadRequest, Conflict, ...refused],
		},
	).middleware(Session),
	HttpApiEndpoint.delete(
		"removeTrigger",
		"/bots/:botId/automations/:automationId/triggers/:triggerId",
		{ params: trigger, success: automationSchema, error: [Conflict, ...refused] },
	).middleware(Session),
	HttpApiEndpoint.get(
		"getSecret",
		"/bots/:botId/automations/:automationId/triggers/:triggerId/secret",
		{ params: trigger, success: automationCurrentSecretSchema, error: refused },
	).middleware(Session),
	HttpApiEndpoint.post(
		"rotateSecret",
		"/bots/:botId/automations/:automationId/triggers/:triggerId/secret",
		{
			params: trigger,
			payload: automationSecretReplacementSchema,
			success: automationSecretSchema,
			error: refused,
		},
	).middleware(Session),
	HttpApiEndpoint.get("runs", "/bots/:botId/automations/:automationId/runs", {
		params: automation,
		query: runPageQuerySchema,
		success: runPageSchema,
		error: refused,
	}).middleware(Session),
	// Any JSON body, carried to the automation as its trigger's payload. The
	// caller proves it holds the trigger's secret the way the trigger's auth
	// says. A delivery id, such as `Idempotency-Key`, makes a retry land on
	// the run the first delivery started. Slack's URL check is answered
	// with its challenge, and starts nothing.
	HttpApiEndpoint.post("webhook", "/hooks/triggers/:triggerId", {
		params: { triggerId: Schema.String },
		payload: Schema.Json,
		success: webhookAnswers,
		error: [BadRequest, Unauthorized, Conflict],
	}),
	// The address a webhook had when an automation had only one trigger: a
	// trigger moved from then has its automation's id, so it is still reached
	// here. Other systems call this address, so it keeps the path it was given.
	HttpApiEndpoint.post("automationWebhook", "/hooks/routines/:automationId", {
		params: { automationId: Schema.String },
		payload: Schema.Json,
		success: webhookAnswers,
		error: [BadRequest, Unauthorized, Conflict],
	}),
) {}

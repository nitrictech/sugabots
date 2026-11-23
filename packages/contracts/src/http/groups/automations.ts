import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	acceptedAutomationWebhookSchema,
	acceptedRunSchema,
	automationCurrentSecretSchema,
	automationSchema,
	automationSecretReplacementSchema,
	automationSecretSchema,
	automationTriggerInputSchema,
	automationUpdateSchema,
	automationWebhookChallengeSchema,
	automationWriteResultSchema,
	ignoredAutomationWebhookSchema,
	listedAutomationDefinitionSchema,
	manualAutomationRunSchema,
	newAutomationSchema,
	runPageQuerySchema,
	runPageSchema,
} from "../../automations.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, refused, Unauthorized } from "../errors.ts";
import { Session } from "../middleware.ts";

/** A project's automations: a bot's own are its default project's. */
const inProject = { projectId: uuidSchema };
const automation = { projectId: uuidSchema, automationId: Schema.String };
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
	HttpApiEndpoint.get("list", "/projects/:projectId/automations", {
		params: inProject,
		success: Schema.Array(listedAutomationDefinitionSchema),
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.post("create", "/projects/:projectId/automations", {
		params: inProject,
		payload: newAutomationSchema,
		success: automationWriteResultSchema.pipe(HttpApiSchema.status(201)),
		error: [Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.patch("update", "/projects/:projectId/automations/:automationId", {
		params: automation,
		payload: automationUpdateSchema,
		success: automationWriteResultSchema,
		error: [Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.delete("remove", "/projects/:projectId/automations/:automationId", {
		params: automation,
		error: refused,
	}).middleware(Session),
	HttpApiEndpoint.post("run", "/projects/:projectId/automations/:automationId/run", {
		params: automation,
		payload: manualAutomationRunSchema,
		success: acceptedRunSchema.pipe(HttpApiSchema.status(202)),
		error: [Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.post("addTrigger", "/projects/:projectId/automations/:automationId/triggers", {
		params: automation,
		payload: automationTriggerInputSchema,
		success: automationWriteResultSchema.pipe(HttpApiSchema.status(201)),
		error: [BadRequest, Conflict, ...refused],
	}).middleware(Session),
	HttpApiEndpoint.put(
		"updateTrigger",
		"/projects/:projectId/automations/:automationId/triggers/:triggerId",
		{
			params: trigger,
			payload: automationTriggerInputSchema,
			success: automationWriteResultSchema,
			error: [BadRequest, Conflict, ...refused],
		},
	).middleware(Session),
	HttpApiEndpoint.delete(
		"removeTrigger",
		"/projects/:projectId/automations/:automationId/triggers/:triggerId",
		{ params: trigger, success: automationSchema, error: [Conflict, ...refused] },
	).middleware(Session),
	HttpApiEndpoint.get(
		"getSecret",
		"/projects/:projectId/automations/:automationId/triggers/:triggerId/secret",
		{ params: trigger, success: automationCurrentSecretSchema, error: refused },
	).middleware(Session),
	HttpApiEndpoint.post(
		"rotateSecret",
		"/projects/:projectId/automations/:automationId/triggers/:triggerId/secret",
		{
			params: trigger,
			payload: automationSecretReplacementSchema,
			success: automationSecretSchema,
			error: refused,
		},
	).middleware(Session),
	/** The runs of every automation of the project, removed ones' included, newest first. */
	HttpApiEndpoint.get("projectRuns", "/projects/:projectId/runs", {
		params: inProject,
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
) {}

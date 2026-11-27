/**
 * The automations operations' contracts, each with its decisions in the exposure manifest.
 * `index.ts` spreads them, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import {
	acceptedAutomationWebhookSchema,
	acceptedRunSchema,
	automationCurrentSecretSchema,
	automationListItemSchema,
	automationSchema,
	automationSecretReplacementSchema,
	automationSecretSchema,
	automationTriggerInputSchema,
	automationUpdateResultSchema,
	automationUpdateSchema,
	automationWebhookChallengeSchema,
	automationWriteResultSchema,
	ignoredAutomationWebhookSchema,
	MAX_CRON_EXPRESSION_CHARACTERS,
	manualAutomationRunSchema,
	newAutomationSchema,
	routineSchema,
	runPageQuerySchema,
	runPageSchema,
} from "../automations.ts";
import {
	AutomationDeliveryIdTooLong,
	AutomationNameTaken,
	AutomationNotFound,
	AutomationRepositoryNotConnected,
	AutomationTriggerConflict,
	AutomationTriggerKindChanged,
	AutomationTriggerNotFound,
	AutomationTriggerRejected,
	InvalidRoutineSchedule,
	TooManyAutomationTriggers,
	TriggerSetInSettings,
	WebhookDeliveryIdHeaderRejected,
	WebhookRefused,
	WebhookSecretTooShort,
} from "../errors/automations.ts";
import { InvalidCursor } from "../errors/chat-reads.ts";
import {
	ActionForbidden,
	ApprovalNeeded,
	ApprovalRefused,
	BotCannotReach,
	ResourceHidden,
	TurnEnded,
} from "../errors/proofs.ts";
import { TurnExecutionSuperseded } from "../errors/turns.ts";
import { repositoryEventSchema } from "../github.ts";
import { uuidOrStringSchema, uuidSchema } from "../uuid.ts";
import { OperationContract } from "./operation.ts";

/** How an operation that proves it reaches a project refuses. */
const reachRefusals = [ResourceHidden, BotCannotReach] as const;

/** How an operation that proves it reaches a project, and may act there, refuses. */
const refusals = [...reachRefusals, ActionForbidden] as const;

/** A project's automations: a bot's own are its default project's. */
const inProject = { projectId: uuidSchema };
const anAutomation = { projectId: uuidSchema, automationId: uuidOrStringSchema };
const aTrigger = { ...anAutomation, triggerId: uuidSchema };

/** How a webhook trigger's settings are written wrong. */
const webhookSettingRefusals = [
	InvalidRoutineSchedule,
	WebhookSecretTooShort,
	WebhookDeliveryIdHeaderRejected,
	AutomationRepositoryNotConnected,
] as const;

export const AUTOMATIONS_TOOL_KEY = "automations";

const approvalRefusals = [ApprovalNeeded, ApprovalRefused] as const;
const chatWriteRefusals = [
	...refusals,
	...approvalRefusals,
	TurnEnded,
	TurnExecutionSuperseded,
] as const;

const automationInChatSchema = Schema.Struct({
	id: uuidSchema,
	name: Schema.String,
	instructions: Schema.String,
	when: Schema.Array(
		Schema.Union([
			Schema.Struct({
				kind: Schema.Literal("routine"),
				schedule: routineSchema,
				timezone: Schema.String,
				nextRunAt: Schema.NullOr(Schema.String),
			}),
			Schema.Struct({ kind: Schema.Literal("webhook") }),
			Schema.Struct({
				kind: Schema.Literal("github"),
				repository: Schema.String,
				events: Schema.Array(repositoryEventSchema),
			}),
		]),
	),
	paused: Schema.Boolean,
	settingsUrl: Schema.String,
});

const routineExpression = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_CRON_EXPRESSION_CHARACTERS),
).annotate({
	description:
		'A five-field cron expression in the workspace timezone. For example, "0 9 * * 1-5" means 9am on weekdays.',
});

/** Held back: triggers are set up in settings, as a webhook's secret is shown once. */
const setUpInSettings = {
	kind: "heldBack",
	reason:
		"Triggers and their secrets are set up in the web app: a webhook's secret is shown once, so one shown in a chat would be read by everyone there.",
} as const;

export const automationsContracts = {
	"automations.list": OperationContract.make("automations.list", {
		description:
			"List a project's automations, by name, with how each stands. An admin restricting a bot they can't talk to sees their names and whether they are on.",
		input: Schema.Struct(inProject),
		output: Schema.Array(automationListItemSchema),
		errors: [...reachRefusals, ...approvalRefusals],
		changes: false,
		http: { kind: "offered", method: "GET", path: "/projects/:projectId/automations" },
		botLoop: {
			kind: "coveredBy",
			operation: "automations.listInChat",
			reason: "The tool lists the current project's automations with a summary of their triggers.",
		},
	}),
	"automations.create": OperationContract.make("automations.create", {
		description:
			"Set up an automation in a project: work its lead bot does on its own, with instructions, started by its routines and triggers. Secrets made for its webhooks are returned once.",
		input: Schema.Struct({ ...inProject, ...newAutomationSchema.fields }),
		output: automationWriteResultSchema,
		errors: [...refusals, AutomationNameTaken, ...webhookSettingRefusals],
		changes: true,
		http: {
			kind: "offered",
			method: "POST",
			path: "/projects/:projectId/automations",
			status: 201,
		},
		botLoop: {
			kind: "coveredBy",
			operation: "automations.createWithRoutine",
			reason:
				"The tool creates an automation with a routine. The web app sets up webhook and GitHub triggers.",
		},
	}),
	"automations.update": OperationContract.make("automations.update", {
		description:
			"Rename an automation, change its instructions, or pause or resume it. An admin restricting a bot they can't talk to may only pause its automations.",
		input: Schema.Struct({ ...anAutomation, changes: automationUpdateSchema }),
		output: automationUpdateResultSchema,
		errors: [...refusals, AutomationNotFound, AutomationNameTaken, InvalidRoutineSchedule],
		changes: true,
		http: {
			kind: "offered",
			method: "PATCH",
			path: "/projects/:projectId/automations/:automationId",
		},
		botLoop: {
			kind: "coveredBy",
			operation: "automations.updateInChat",
			reason: "The tool updates automation settings and can also change its sole routine.",
		},
	}),
	"automations.listInChat": OperationContract.make("automations.listInChat", {
		description:
			"List the automations of this chat's project, with what starts each and whether it is paused. In your own chats these are your automations. Check here before setting up an automation to avoid a duplicate.",
		input: Schema.Record(Schema.String, Schema.Never),
		output: Schema.Struct({ automations: Schema.Array(automationInChatSchema) }),
		errors: [...reachRefusals, ...approvalRefusals],
		changes: false,
		http: { kind: "heldBack", reason: "The HTTP API lists automations by project id." },
		botLoop: {
			kind: "offered",
			tool: "list_automations",
			offeredIn: "everywhere",
			approval: { kind: "never" },
			personalBotAsks: false,
		},
	}),
	"automations.createWithRoutine": OperationContract.make("automations.createWithRoutine", {
		description:
			"Set up an automation in this chat's project with a routine in the workspace timezone. Only do this when the asker requests or agrees to it. The project's lead bot runs it. Tell the asker when it runs and link its name to the settingsUrl you receive.",
		input: Schema.Struct({
			name: newAutomationSchema.fields.name,
			instructions: newAutomationSchema.fields.instructions,
			routineExpression,
		}),
		output: Schema.Struct({ automation: automationInChatSchema }),
		errors: [...chatWriteRefusals, AutomationNameTaken, InvalidRoutineSchedule],
		changes: true,
		http: {
			kind: "heldBack",
			reason: "The HTTP API creates automations with an explicit project and triggers.",
		},
		botLoop: {
			kind: "offered",
			tool: "create_automation",
			offeredIn: "chatBounds",
			approval: { kind: "always", approvers: "turn" },
			personalBotAsks: true,
		},
	}),
	"automations.updateInChat": OperationContract.make("automations.updateInChat", {
		description:
			"Change an automation in this chat's project. Use its ID from list_automations and give only what changes. A routine runs in the workspace timezone. It adds a first routine or replaces the only routine. Use the Automations page to change routines or triggers when there is more than one routine, a webhook, or a GitHub trigger.",
		input: Schema.Struct({
			automationId: uuidSchema,
			name: automationUpdateSchema.fields.name,
			instructions: automationUpdateSchema.fields.instructions,
			routineExpression: Schema.optional(routineExpression),
			paused: Schema.optional(Schema.Boolean),
		}),
		output: Schema.Struct({ automation: automationInChatSchema }),
		errors: [
			...chatWriteRefusals,
			AutomationNotFound,
			AutomationNameTaken,
			InvalidRoutineSchedule,
			TriggerSetInSettings,
		],
		changes: true,
		http: {
			kind: "heldBack",
			reason: "The HTTP API addresses the automation and its triggers explicitly.",
		},
		botLoop: {
			kind: "offered",
			tool: "update_automation",
			offeredIn: "chatBounds",
			approval: { kind: "always", approvers: "turn" },
			personalBotAsks: true,
		},
	}),
	"automations.remove": OperationContract.make("automations.remove", {
		description: "Delete an automation. Its runs and their chats are kept.",
		input: Schema.Struct(anAutomation),
		output: Schema.Void,
		errors: [...refusals, AutomationNotFound],
		changes: true,
		http: {
			kind: "offered",
			method: "DELETE",
			path: "/projects/:projectId/automations/:automationId",
		},
		botLoop: {
			kind: "heldBack",
			reason: "No tool deletes an automation; offering one waits for tools to become operations.",
		},
	}),
	"automations.run": OperationContract.make("automations.run", {
		description:
			"Start a run by hand, even if the automation is paused. The workspace's owner, admins and editors can start runs in projects they belong to and for bots they can talk to. Viewers can start runs for their own personal bots. Asking again with the same request id returns that run.",
		input: Schema.Struct({ ...anAutomation, ...manualAutomationRunSchema.fields }),
		output: acceptedRunSchema,
		errors: [...refusals, AutomationNotFound, AutomationTriggerConflict, AutomationTriggerRejected],
		changes: true,
		http: {
			kind: "offered",
			method: "POST",
			path: "/projects/:projectId/automations/:automationId/run",
			status: 202,
		},
		botLoop: {
			kind: "heldBack",
			reason:
				"No tool starts a manual run, and a run may start none; offering one waits for tools to become operations.",
		},
	}),
	"automations.addTrigger": OperationContract.make("automations.addTrigger", {
		description:
			"Add a routine, webhook or GitHub trigger to an automation. A secret made for a webhook is returned once.",
		input: Schema.Struct({ ...anAutomation, trigger: automationTriggerInputSchema }),
		output: automationWriteResultSchema,
		errors: [...refusals, AutomationNotFound, TooManyAutomationTriggers, ...webhookSettingRefusals],
		changes: true,
		http: {
			kind: "offered",
			method: "POST",
			path: "/projects/:projectId/automations/:automationId/triggers",
			status: 201,
		},
		botLoop: setUpInSettings,
	}),
	"automations.updateTrigger": OperationContract.make("automations.updateTrigger", {
		description:
			"Rewrite one of an automation's triggers, which keeps its kind. A webhook keeps its secret unless one is brought.",
		input: Schema.Struct({ ...aTrigger, trigger: automationTriggerInputSchema }),
		output: automationWriteResultSchema,
		errors: [
			...refusals,
			AutomationNotFound,
			AutomationTriggerNotFound,
			AutomationTriggerKindChanged,
			...webhookSettingRefusals,
		],
		changes: true,
		http: {
			kind: "offered",
			method: "PUT",
			path: "/projects/:projectId/automations/:automationId/triggers/:triggerId",
		},
		botLoop: setUpInSettings,
	}),
	"automations.removeTrigger": OperationContract.make("automations.removeTrigger", {
		description: "Remove one of an automation's routines or triggers.",
		input: Schema.Struct(aTrigger),
		output: automationSchema,
		errors: [...refusals, AutomationNotFound, AutomationTriggerNotFound],
		changes: true,
		http: {
			kind: "offered",
			method: "DELETE",
			path: "/projects/:projectId/automations/:automationId/triggers/:triggerId",
		},
		botLoop: setUpInSettings,
	}),
	"automations.getSecret": OperationContract.make("automations.getSecret", {
		description: "A webhook trigger's current secret, or that it has none.",
		input: Schema.Struct(aTrigger),
		output: automationCurrentSecretSchema,
		errors: [...refusals, AutomationNotFound, AutomationTriggerNotFound, AutomationTriggerRejected],
		changes: false,
		http: {
			kind: "offered",
			method: "GET",
			path: "/projects/:projectId/automations/:automationId/triggers/:triggerId/secret",
		},
		botLoop: setUpInSettings,
	}),
	"automations.rotateSecret": OperationContract.make("automations.rotateSecret", {
		description:
			"Replace a webhook trigger's secret with the one given, a new one when none is, or none at all, which lets anyone with its address run it.",
		input: Schema.Struct({ ...aTrigger, ...automationSecretReplacementSchema.fields }),
		output: automationSecretSchema,
		errors: [
			...refusals,
			AutomationNotFound,
			AutomationTriggerNotFound,
			AutomationTriggerRejected,
			WebhookSecretTooShort,
		],
		changes: true,
		http: {
			kind: "offered",
			method: "POST",
			path: "/projects/:projectId/automations/:automationId/triggers/:triggerId/secret",
		},
		botLoop: setUpInSettings,
	}),
	"automations.projectRuns": OperationContract.make("automations.projectRuns", {
		description:
			"A page of the runs of every automation of a project, removed ones' included, newest first.",
		input: Schema.Struct({ ...inProject, ...runPageQuerySchema.fields }),
		output: runPageSchema,
		errors: [...reachRefusals, InvalidCursor],
		changes: false,
		http: { kind: "offered", method: "GET", path: "/projects/:projectId/runs" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It is the web app's list of a project's runs; each run's own chat shows what it did.",
		},
	}),
	"automations.webhook": OperationContract.make("automations.webhook", {
		description:
			"Start the run a call to an automation's webhook asks for, unless its filter turns the call away. A retry with the same delivery id lands on the run the first started.",
		input: Schema.Struct({
			triggerId: uuidOrStringSchema,
			/** By lower-case name. */
			headers: Schema.Record(Schema.String, Schema.String),
			payload: Schema.Json,
		}),
		output: Schema.Union([
			acceptedAutomationWebhookSchema,
			ignoredAutomationWebhookSchema,
			automationWebhookChallengeSchema,
		]),
		errors: [
			WebhookRefused,
			AutomationTriggerConflict,
			AutomationTriggerRejected,
			AutomationDeliveryIdTooLong,
		],
		changes: true,
		http: {
			kind: "heldBack",
			reason:
				"Webhooks are an entrypoint of their own: the webhook route calls it for the call the webhook authenticator accepted, with no session.",
		},
		botLoop: {
			kind: "heldBack",
			reason: "Only a call to the webhook starts a run from its trigger.",
		},
	}),
} as const;

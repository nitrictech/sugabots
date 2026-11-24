/**
 * The automations operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
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
	WebhookDeliveryIdHeaderRejected,
	WebhookRefused,
	WebhookSecretTooShort,
} from "../errors/automations.ts";
import { InvalidCursor } from "../errors/chat-reads.ts";
import { ActionForbidden, BotCannotReach, ResourceHidden } from "../errors/proofs.ts";
import { uuidSchema } from "../uuid.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

/** How an operation that proves it reaches a project refuses. */
const reachRefusals = [ResourceHidden, BotCannotReach] as const;

/** How an operation that proves it reaches a project, and may act there, refuses. */
const refusals = [...reachRefusals, ActionForbidden] as const;

/** A project's automations: a bot's own are its default project's. */
const inProject = { projectId: uuidSchema };
const anAutomation = { projectId: uuidSchema, automationId: Schema.String };
const aTrigger = { ...anAutomation, triggerId: uuidSchema };

/** How a webhook trigger's settings are written wrong. */
const webhookSettingRefusals = [
	InvalidRoutineSchedule,
	WebhookSecretTooShort,
	WebhookDeliveryIdHeaderRejected,
	AutomationRepositoryNotConnected,
] as const;

export const automationsContracts = {
	"automations.list": OperationContract.make("automations.list", {
		description:
			"List a project's automations, by name, with how each stands. An admin restricting a bot they can't talk to sees its automations as set up, not how they ran.",
		input: Schema.Struct(inProject),
		output: Schema.Array(listedAutomationDefinitionSchema),
		errors: reachRefusals,
		changes: false,
	}),
	"automations.create": OperationContract.make("automations.create", {
		description:
			"Set up an automation in a project: work its lead bot does on its own, with instructions, started by its routines and triggers. Secrets made for its webhooks are returned once.",
		input: Schema.Struct({ ...inProject, ...newAutomationSchema.fields }),
		output: automationWriteResultSchema,
		errors: [...refusals, AutomationNameTaken, ...webhookSettingRefusals],
		changes: true,
	}),
	"automations.update": OperationContract.make("automations.update", {
		description:
			"Rename an automation, change its instructions, or pause or resume it. An admin restricting a bot they can't talk to may only pause its automations.",
		input: Schema.Struct({ ...anAutomation, changes: automationUpdateSchema }),
		output: automationWriteResultSchema,
		errors: [...refusals, AutomationNotFound, AutomationNameTaken, InvalidRoutineSchedule],
		changes: true,
	}),
	"automations.remove": OperationContract.make("automations.remove", {
		description: "Delete an automation. Its runs and their chats are kept.",
		input: Schema.Struct(anAutomation),
		output: Schema.Void,
		errors: [...refusals, AutomationNotFound],
		changes: true,
	}),
	"automations.run": OperationContract.make("automations.run", {
		description:
			"Run an automation now, outside its routines and triggers. Asking again with the same request id returns that run.",
		input: Schema.Struct({ ...anAutomation, ...manualAutomationRunSchema.fields }),
		output: acceptedRunSchema,
		errors: [...refusals, AutomationNotFound, AutomationTriggerConflict, AutomationTriggerRejected],
		changes: true,
	}),
	"automations.addTrigger": OperationContract.make("automations.addTrigger", {
		description:
			"Add a routine, webhook or GitHub trigger to an automation. A secret made for a webhook is returned once.",
		input: Schema.Struct({ ...anAutomation, trigger: automationTriggerInputSchema }),
		output: automationWriteResultSchema,
		errors: [...refusals, AutomationNotFound, TooManyAutomationTriggers, ...webhookSettingRefusals],
		changes: true,
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
	}),
	"automations.removeTrigger": OperationContract.make("automations.removeTrigger", {
		description: "Remove one of an automation's routines or triggers.",
		input: Schema.Struct(aTrigger),
		output: automationSchema,
		errors: [...refusals, AutomationNotFound, AutomationTriggerNotFound],
		changes: true,
	}),
	"automations.getSecret": OperationContract.make("automations.getSecret", {
		description: "A webhook trigger's current secret, or that it has none.",
		input: Schema.Struct(aTrigger),
		output: automationCurrentSecretSchema,
		errors: [...refusals, AutomationNotFound, AutomationTriggerNotFound, AutomationTriggerRejected],
		changes: false,
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
	}),
	"automations.projectRuns": OperationContract.make("automations.projectRuns", {
		description:
			"A page of the runs of every automation of a project, removed ones' included, newest first.",
		input: Schema.Struct({ ...inProject, ...runPageQuerySchema.fields }),
		output: runPageSchema,
		errors: [...reachRefusals, InvalidCursor],
		changes: false,
	}),
	"automations.webhook": OperationContract.make("automations.webhook", {
		description:
			"Start the run a call to an automation's webhook asks for, unless its filter turns the call away. A retry with the same delivery id lands on the run the first started.",
		input: Schema.Struct({
			triggerId: Schema.String,
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
	}),
} as const;

/** Held back until tools become operations: the automation tool `tool` does this today. */
const doneByAutomationTool = <const Tool extends string>(tool: Tool) =>
	({
		kind: "heldBack",
		reason: `Until tools become operations: a bot's ${tool} tool does this for its asker in the project it works in, through BotAutomations.`,
	}) as const;

/** Held back: triggers are set up in settings, as a webhook's secret is shown once. */
const setUpInSettings = {
	kind: "heldBack",
	reason:
		"Triggers and their secrets are set up in the web app: a webhook's secret is shown once, so one shown in a chat would be read by everyone there.",
} as const;

export const automationsExposure = {
	"automations.list": {
		http: { kind: "offered", endpoint: "automations.list" },
		botLoop: doneByAutomationTool("list_automations"),
	},
	"automations.create": {
		http: { kind: "offered", endpoint: "automations.create" },
		botLoop: doneByAutomationTool("create_automation"),
	},
	"automations.update": {
		http: { kind: "offered", endpoint: "automations.update" },
		botLoop: doneByAutomationTool("update_automation"),
	},
	"automations.remove": {
		http: { kind: "offered", endpoint: "automations.remove" },
		botLoop: {
			kind: "heldBack",
			reason: "No tool deletes an automation; offering one waits for tools to become operations.",
		},
	},
	"automations.run": {
		http: { kind: "offered", endpoint: "automations.run" },
		botLoop: {
			kind: "heldBack",
			reason:
				"No tool starts a manual run, and a run may start none; offering one waits for tools to become operations.",
		},
	},
	"automations.addTrigger": {
		http: { kind: "offered", endpoint: "automations.addTrigger" },
		botLoop: setUpInSettings,
	},
	"automations.updateTrigger": {
		http: { kind: "offered", endpoint: "automations.updateTrigger" },
		botLoop: setUpInSettings,
	},
	"automations.removeTrigger": {
		http: { kind: "offered", endpoint: "automations.removeTrigger" },
		botLoop: setUpInSettings,
	},
	"automations.getSecret": {
		http: { kind: "offered", endpoint: "automations.getSecret" },
		botLoop: setUpInSettings,
	},
	"automations.rotateSecret": {
		http: { kind: "offered", endpoint: "automations.rotateSecret" },
		botLoop: setUpInSettings,
	},
	"automations.projectRuns": {
		http: { kind: "offered", endpoint: "automations.projectRuns" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It is the web app's list of a project's runs; each run's own chat shows what it did.",
		},
	},
	"automations.webhook": {
		http: {
			kind: "heldBack",
			reason:
				"Webhooks are an entrypoint of their own: the webhook route calls it for the call the webhook authenticator accepted, with no session.",
		},
		botLoop: {
			kind: "heldBack",
			reason: "Only a call to the webhook starts a run from its trigger.",
		},
	},
} as const satisfies DomainExposure<typeof automationsContracts>;

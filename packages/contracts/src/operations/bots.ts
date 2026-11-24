/**
 * The bots operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import {
	botSchema,
	botUpdateSchema,
	modelIdSchema,
	newBotSchema,
	systemBotKeySchema,
} from "../bots.ts";
import {
	AssistantInstructionsManaged,
	AssistantManaged,
	AssistantVisibilityFixed,
	BotGone,
	BotHandleReserved,
	BotNameTaken,
	EmptyBotUpdate,
	SystemBotImmutable,
	SystemBotMissing,
} from "../errors/bots.ts";
import { ComputerMadeMeanwhile, ComputerUnavailable } from "../errors/computers.ts";
import { LeadsProjects } from "../errors/projects.ts";
import { ActionForbidden, ResourceHidden } from "../errors/proofs.ts";
import { ModelNotEnabled } from "../errors/providers.ts";
import { systemBotSchema, systemBotUpdateSchema } from "../system-bots.ts";
import { uuidSchema } from "../uuid.ts";
import { workspaceIdOrSlugSchema } from "../workspaces.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

/** How an operation that proves what it may do in a workspace, or to a bot, refuses. */
const refusals = [ResourceHidden, ActionForbidden] as const;

/** A bot, by its id. */
const aBot = Schema.Struct({ botId: uuidSchema });

export const botsContracts = {
	"bots.list": OperationContract.make("bots.list", {
		description:
			"List the workspace's bots you can talk to, by name, and for an admin every personal bot too.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema }),
		output: Schema.Array(botSchema),
		errors: refusals,
		changes: false,
	}),
	"bots.create": OperationContract.make("bots.create", {
		description:
			"Make a bot on a model the workspace offers, pinned for you. Without instructions it starts by interviewing you to write them.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema, ...newBotSchema.fields }),
		output: botSchema,
		errors: [...refusals, ModelNotEnabled, BotNameTaken, BotHandleReserved],
		changes: true,
	}),
	"bots.update": OperationContract.make("bots.update", {
		description:
			"Change a bot you manage: its name, handle, avatar, description, instructions, model, visibility, tools or computer use. Of a Personal Assistant, only its name and avatar.",
		input: Schema.Struct({ botId: uuidSchema, changes: botUpdateSchema }),
		output: botSchema,
		errors: [
			...refusals,
			EmptyBotUpdate,
			ModelNotEnabled,
			BotNameTaken,
			BotHandleReserved,
			BotGone,
			SystemBotImmutable,
			LeadsProjects,
			AssistantVisibilityFixed,
			AssistantInstructionsManaged,
			AssistantManaged,
		],
		changes: true,
	}),
	"bots.remove": OperationContract.make("bots.remove", {
		description:
			"Delete a bot, with its chats, files, connectors, automations and computer. It is kept while it leads a project, or when its computer provider can't be reached.",
		input: aBot,
		output: Schema.Void,
		errors: [
			...refusals,
			SystemBotImmutable,
			LeadsProjects,
			ComputerUnavailable,
			ComputerMadeMeanwhile,
		],
		changes: true,
	}),
	"bots.pin": OperationContract.make("bots.pin", {
		description: "Pin a bot you can talk to in your sidebar.",
		input: aBot,
		output: botSchema,
		errors: refusals,
		changes: true,
	}),
	"bots.unpin": OperationContract.make("bots.unpin", {
		description: "Take a bot off your sidebar.",
		input: aBot,
		output: botSchema,
		errors: refusals,
		changes: true,
	}),
	"bots.ensureAssistant": OperationContract.make("bots.ensureAssistant", {
		description:
			"Your Personal Assistant in the workspace, made on the model given when you have none yet.",
		input: Schema.Struct({
			workspace: workspaceIdOrSlugSchema,
			model: Schema.optional(modelIdSchema),
		}),
		output: botSchema,
		errors: [...refusals, ModelNotEnabled],
		changes: true,
	}),
	"systemBots.list": OperationContract.make("systemBots.list", {
		description:
			"List the workspace's system bots, such as Compaction, with the model each runs on.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema }),
		output: Schema.Array(systemBotSchema),
		errors: refusals,
		changes: false,
	}),
	"systemBots.update": OperationContract.make("systemBots.update", {
		description: "Choose the model, one the workspace offers, that one of its system bots runs on.",
		input: Schema.Struct({
			workspace: workspaceIdOrSlugSchema,
			key: systemBotKeySchema,
			...systemBotUpdateSchema.fields,
		}),
		output: systemBotSchema,
		errors: [...refusals, ModelNotEnabled, SystemBotMissing],
		changes: true,
	}),
} as const;

/** Held back until tools become operations: a Personal Assistant's `tool` does this today. */
const doneByAssistantTool = <const Tool extends string>(tool: Tool) =>
	({
		kind: "heldBack",
		reason: `Until tools become operations: a Personal Assistant's ${tool} tool does this for its member, through BotAdministration.`,
	}) as const;

/** Held back: it manages the workspace or a bot, which a bot may do only in member bounds. */
const managesInMemberBounds = {
	kind: "heldBack",
	reason:
		"It manages the workspace or a bot, which a bot may do only in member bounds, and no tool does it yet.",
} as const;

export const botsExposure = {
	"bots.list": {
		http: { kind: "offered", endpoint: "bots.list" },
		botLoop: doneByAssistantTool("workspace_guide"),
	},
	"bots.create": {
		http: { kind: "offered", endpoint: "bots.create" },
		botLoop: managesInMemberBounds,
	},
	"bots.update": {
		http: { kind: "offered", endpoint: "bots.update" },
		botLoop: {
			kind: "heldBack",
			reason:
				"Until tools become operations: a bot's save_instructions tool writes its own instructions and description in its own chats, through BotAdministration; any other change manages a bot, which a bot may do only in member bounds.",
		},
	},
	"bots.remove": {
		http: { kind: "offered", endpoint: "bots.remove" },
		botLoop: {
			kind: "heldBack",
			reason: "Deleting a bot deletes its chats, files and computer; members do it in the web app.",
		},
	},
	"bots.pin": {
		http: { kind: "offered", endpoint: "bots.pin" },
		botLoop: doneByAssistantTool("pin_bot"),
	},
	"bots.unpin": {
		http: { kind: "offered", endpoint: "bots.unpin" },
		botLoop: doneByAssistantTool("pin_bot"),
	},
	"bots.ensureAssistant": {
		http: { kind: "offered", endpoint: "bots.ensureAssistant" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It makes a signed-in member's own Personal Assistant, which the web app asks for as they arrive; a bot's asker has one already.",
		},
	},
	"systemBots.list": {
		http: { kind: "offered", endpoint: "systemBots.list" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It is the workspace settings' list of the system bots' models, which no bot chooses.",
		},
	},
	"systemBots.update": {
		http: { kind: "offered", endpoint: "systemBots.update" },
		botLoop: managesInMemberBounds,
	},
} as const satisfies DomainExposure<typeof botsContracts>;

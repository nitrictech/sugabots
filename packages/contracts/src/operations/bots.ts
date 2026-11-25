/**
 * The bots operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import {
	botSchema,
	botUpdateSchema,
	DESCRIPTION_MAX_LENGTH,
	INSTRUCTIONS_MAX_LENGTH,
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
import { ClaimLost, ComputerMadeMeanwhile, ComputerUnavailable } from "../errors/computers.ts";
import { LeadsProjects } from "../errors/projects.ts";
import {
	ActionForbidden,
	ApprovalNeeded,
	ApprovalRefused,
	ResourceHidden,
	TurnEnded,
} from "../errors/proofs.ts";
import { ModelNotEnabled } from "../errors/providers.ts";
import { TurnExecutionSuperseded } from "../errors/turns.ts";
import { systemBotSchema, systemBotUpdateSchema } from "../system-bots.ts";
import { uuidSchema } from "../uuid.ts";
import { workspaceIdOrSlugSchema } from "../workspaces.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

/** How an operation that proves what it may do in a workspace, or to a bot, refuses. */
const refusals = [ResourceHidden, ActionForbidden] as const;

/** How a bot's call that may wait for approval, and writes for its turn, is refused. */
const approvalAndFenceRefusals = [
	ApprovalNeeded,
	ApprovalRefused,
	TurnEnded,
	TurnExecutionSuperseded,
] as const;

/** A bot, by its id. */
const aBot = Schema.Struct({ botId: uuidSchema.annotate({ description: "The bot's id." }) });

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
	"bots.saveInstructions": OperationContract.make("bots.saveInstructions", {
		description:
			"Replace your instructions and description, passing the whole text. Call it when setting yourself up, when someone asks you to change how you work, or when their reply shows you set yourself up for the wrong kind of work: then set yourself up again for the work they meant, and do that work yourself. Not for remembering things about a member. The member approves it before it is saved. Returns your settings page, where members read and change them.",
		input: Schema.Struct({
			instructions: Schema.String.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(INSTRUCTIONS_MAX_LENGTH),
			).annotate({ description: "Your instructions in Markdown, addressed to yourself." }),
			description: Schema.String.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(DESCRIPTION_MAX_LENGTH),
			).annotate({
				description:
					"One or two sentences telling the other bots in the workspace what to come to you for.",
			}),
		}),
		output: Schema.Struct({
			saved: Schema.Literal(true),
			/** The bot's settings page, where members read and change what was saved. */
			settingsUrl: Schema.String,
		}),
		errors: [...refusals, BotGone, AssistantInstructionsManaged, ...approvalAndFenceRefusals],
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
			ClaimLost,
		],
		changes: true,
	}),
	"bots.pin": OperationContract.make("bots.pin", {
		description:
			"Pin a bot you can talk to in your sidebar, or for a bot, in the sidebar of the member it acts for.",
		input: aBot,
		output: botSchema,
		errors: [...refusals, ...approvalAndFenceRefusals],
		changes: true,
	}),
	"bots.unpin": OperationContract.make("bots.unpin", {
		description:
			"Take a bot off your sidebar, or for a bot, off the sidebar of the member it acts for.",
		input: aBot,
		output: botSchema,
		errors: [...refusals, ...approvalAndFenceRefusals],
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

/**
 * Offered as `tool` only in member bounds, a Personal Assistant's own turns,
 * where each call asks its member: it changes the member's own sidebar.
 */
const forMemberInMemberBounds = <const Tool extends string>(tool: Tool) =>
	({
		kind: "offered",
		tool,
		offeredIn: "memberBounds",
		approval: { kind: "always", approvers: "turn" },
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
		botLoop: {
			kind: "coveredBy",
			operation: "workspaces.guide",
			reason: "A Personal Assistant's workspace guide lists the bots its member reaches.",
		},
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
				"A bot changes only its own instructions and description, through bots.saveInstructions; any other change manages a bot, which a bot may do only in member bounds, and no tool does it yet.",
		},
	},
	"bots.saveInstructions": {
		http: {
			kind: "heldBack",
			reason:
				"A bot saves its own instructions in a turn; members change a bot through bots.update.",
		},
		botLoop: {
			kind: "offered",
			tool: "save_instructions",
			offeredIn: "ownChats",
			approval: { kind: "always", approvers: "turn" },
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
		botLoop: forMemberInMemberBounds("pin_bot"),
	},
	"bots.unpin": {
		http: { kind: "offered", endpoint: "bots.unpin" },
		botLoop: forMemberInMemberBounds("unpin_bot"),
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

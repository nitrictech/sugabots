/**
 * The bots operations' contracts, each with its decisions in the exposure manifest.
 * `index.ts` spreads them, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import {
	botMemberSchema,
	botSchema,
	botUpdateSchema,
	DESCRIPTION_MAX_LENGTH,
	INSTRUCTIONS_MAX_LENGTH,
	newBotSchema,
	systemBotKeySchema,
} from "../bots.ts";
import {
	AdministratorInEveryPrivateBot,
	AssistantHandleFixed,
	AssistantInstructionsManaged,
	BotGone,
	BotHandleReserved,
	BotNameTaken,
	EmptyBotUpdate,
	NotBotMember,
	PersonalVisibilityFixed,
	SystemBotImmutable,
	SystemBotMissing,
} from "../errors/bots.ts";
import { ClaimLost, ComputerMadeMeanwhile, ComputerUnavailable } from "../errors/computers.ts";
import { LeadsProjects, NotInWorkspace } from "../errors/projects.ts";
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

/**
 * Offered as `tool` only in member bounds, a personal bot's own turns,
 * where each call asks its creator: it changes the member's own sidebar.
 */
const forMemberInMemberBounds = <const Tool extends string>(tool: Tool) =>
	({
		kind: "offered",
		tool,
		offeredIn: "memberBounds",
		approval: { kind: "always", approvers: "turn" },
		personalBotAsks: true,
	}) as const;

/** Held back: it changes who reaches a bot, which a bot may do only in member bounds. */
const changesWhoReaches = {
	kind: "heldBack",
	reason:
		"It changes who reaches a bot, which a bot may do only in member bounds, and no tool does it yet.",
} as const;

/** Held back: it manages the workspace or a bot, which a bot may do only in member bounds. */
const managesInMemberBounds = {
	kind: "heldBack",
	reason:
		"It manages the workspace or a bot, which a bot may do only in member bounds, and no tool does it yet.",
} as const;

export const botsContracts = {
	"bots.list": OperationContract.make("bots.list", {
		description:
			"List the workspace's bots you can talk to, by name, and for an admin every personal bot too.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema }),
		output: Schema.Array(botSchema),
		errors: refusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/workspaces/:workspace/bots" },
		botLoop: {
			kind: "coveredBy",
			operation: "workspaces.guide",
			reason: "A Personal Assistant's workspace guide lists the bots its member reaches.",
		},
	}),
	"bots.create": OperationContract.make("bots.create", {
		description:
			"Make a bot on a model the workspace offers, pinned for you. Without instructions it starts by interviewing you to write them.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema, ...newBotSchema.fields }),
		output: botSchema,
		errors: [...refusals, ModelNotEnabled, BotNameTaken, BotHandleReserved],
		changes: true,
		http: { kind: "offered", method: "POST", path: "/workspaces/:workspace/bots", status: 201 },
		botLoop: managesInMemberBounds,
	}),
	"bots.update": OperationContract.make("bots.update", {
		description:
			"Change a bot you manage: its name, handle, avatar, description, instructions, model, tools, computer use, or whether it is public or private. A bot made private leaves every public project, once each it leads has another lead. Whether a bot is personal is chosen when it is made and never changes. Of a Personal Assistant, all but its instructions and handle.",
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
			PersonalVisibilityFixed,
			AssistantInstructionsManaged,
			AssistantHandleFixed,
			LeadsProjects,
		],
		changes: true,
		http: { kind: "offered", method: "PATCH", path: "/bots/:botId" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A bot changes only its own instructions and description, through bots.saveInstructions; any other change manages a bot, which a bot may do only in member bounds, and no tool does it yet.",
		},
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
			personalBotAsks: true,
		},
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
		http: { kind: "offered", method: "DELETE", path: "/bots/:botId" },
		botLoop: {
			kind: "heldBack",
			reason: "Deleting a bot deletes its chats, files and computer; members do it in the web app.",
		},
	}),
	"bots.listMembers": OperationContract.make("bots.listMembers", {
		description: "List the members of a private bot, by name.",
		input: aBot,
		output: Schema.Array(botMemberSchema),
		errors: refusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/bots/:botId/members" },
		botLoop: {
			kind: "heldBack",
			reason: "No tool lists a bot's members; offering one waits for tools to become operations.",
		},
	}),
	"bots.addMember": OperationContract.make("bots.addMember", {
		description:
			"Invite a member of the workspace to a private bot, so they see it and talk to it, with its chats and files.",
		input: Schema.Struct({
			botId: uuidSchema,
			memberId: uuidSchema.annotate({ description: "The member's id." }),
		}),
		output: Schema.Void,
		errors: [...refusals, NotInWorkspace],
		changes: true,
		http: { kind: "offered", method: "POST", path: "/bots/:botId/members" },
		botLoop: changesWhoReaches,
	}),
	"bots.removeMember": OperationContract.make("bots.removeMember", {
		description:
			"Take a member out of a private bot. The workspace's owner and admins stay in every one.",
		input: Schema.Struct({ botId: uuidSchema, memberId: uuidSchema }),
		output: Schema.Void,
		errors: [...refusals, AdministratorInEveryPrivateBot, NotBotMember],
		changes: true,
		http: { kind: "offered", method: "DELETE", path: "/bots/:botId/members/:memberId" },
		botLoop: changesWhoReaches,
	}),
	"bots.pin": OperationContract.make("bots.pin", {
		description:
			"Pin a bot you can talk to in your sidebar, or for a bot, in the sidebar of the member it acts for.",
		input: aBot,
		output: botSchema,
		errors: [...refusals, ...approvalAndFenceRefusals],
		changes: true,
		http: { kind: "offered", method: "PUT", path: "/bots/:botId/pin" },
		botLoop: forMemberInMemberBounds("pin_bot"),
	}),
	"bots.unpin": OperationContract.make("bots.unpin", {
		description:
			"Take a bot off your sidebar, or for a bot, off the sidebar of the member it acts for.",
		input: aBot,
		output: botSchema,
		errors: [...refusals, ...approvalAndFenceRefusals],
		changes: true,
		http: { kind: "offered", method: "DELETE", path: "/bots/:botId/pin" },
		botLoop: forMemberInMemberBounds("unpin_bot"),
	}),
	"bots.createAssistant": OperationContract.make("bots.createAssistant", {
		description:
			"Make yourself a Personal Assistant, whatever your role, on the workspace's default model. It is listed with your others, oldest first.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema }),
		output: botSchema,
		errors: refusals,
		changes: true,
		http: {
			kind: "offered",
			method: "POST",
			path: "/workspaces/:workspace/assistants",
			status: 201,
		},
		botLoop: {
			kind: "heldBack",
			reason:
				"A member makes their own Personal Assistants from the web app; joining a workspace gives them their first. A bot that made one would make a bot for its asker, which no tool does yet.",
		},
	}),
	"systemBots.list": OperationContract.make("systemBots.list", {
		description:
			"List the workspace's system bots, such as Compaction, with the model each runs on.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema }),
		output: Schema.Array(systemBotSchema),
		errors: refusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/workspaces/:workspace/system-bots" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It is the workspace settings' list of the system bots' models, which no bot chooses.",
		},
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
		http: { kind: "offered", method: "PATCH", path: "/workspaces/:workspace/system-bots/:key" },
		botLoop: managesInMemberBounds,
	}),
} as const;

/**
 * The projects operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import { botSchema } from "../bots.ts";
import { ClaimLost, ComputerMadeMeanwhile, ComputerUnavailable } from "../errors/computers.ts";
import {
	AdministratorInEveryProject,
	BotNotPublic,
	EmptyProjectUpdate,
	InvalidProjectDetails,
	LeadsProjects,
	NotInProject,
	NotInWorkspace,
	ProjectGone,
	ProjectSlugTaken,
	UnusableProjectName,
} from "../errors/projects.ts";
import {
	ActionForbidden,
	ApprovalNeeded,
	ApprovalRefused,
	BotCannotReach,
	ResourceHidden,
	TurnEnded,
} from "../errors/proofs.ts";
import { TurnExecutionSuperseded } from "../errors/turns.ts";
import { memberParticipantSchema } from "../messages.ts";
import {
	newProjectMemberSchema,
	newProjectSchema,
	projectMemberSchema,
	projectSchema,
	projectUpdateSchema,
} from "../projects.ts";
import { uuidOrStringSchema, uuidSchema } from "../uuid.ts";
import { workspaceIdOrSlugSchema } from "../workspaces.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

/** How an operation that proves it reaches a project refuses. */
const reachRefusals = [ResourceHidden, BotCannotReach] as const;

/** How an operation that proves it reaches a project, and may act there, refuses. */
const refusals = [...reachRefusals, ActionForbidden] as const;

/** How an operation that proves what it may do in a workspace refuses. */
const workspaceRefusals = [ResourceHidden, ActionForbidden] as const;

/** How a bot's call that may wait for approval, and writes for its turn, is refused. */
const approvalAndFenceRefusals = [
	ApprovalNeeded,
	ApprovalRefused,
	TurnEnded,
	TurnExecutionSuperseded,
] as const;

const projectIdSchema = uuidSchema.annotate({ description: "The project's id." });

/** A project, by its id. */
const aProject = Schema.Struct({ projectId: projectIdSchema });

export const projectsContracts = {
	"projects.list": OperationContract.make("projects.list", {
		description:
			"List the workspace's projects you are in, and the public ones you could join, by name.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema }),
		output: Schema.Array(projectSchema),
		errors: workspaceRefusals,
		changes: false,
	}),
	"projects.create": OperationContract.make("projects.create", {
		description:
			"Make a project led by a public bot, with you in it, or for a bot, the member it acts for. Public projects are listed for anyone in the workspace to join; private ones only for the members added. Its address is derived from its name unless you give one.",
		input: Schema.Struct({
			workspace: workspaceIdOrSlugSchema.annotate({
				description: "The workspace's id or address.",
			}),
			...newProjectSchema.fields,
		}),
		output: projectSchema,
		errors: [
			...workspaceRefusals,
			InvalidProjectDetails,
			UnusableProjectName,
			ProjectSlugTaken,
			BotNotPublic,
			...approvalAndFenceRefusals,
		],
		changes: true,
	}),
	"projects.update": OperationContract.make("projects.update", {
		description:
			"Change a project's name, address, colour, description, visibility or lead bot, which must be public.",
		input: Schema.Struct({ projectId: uuidSchema, changes: projectUpdateSchema }),
		output: projectSchema,
		errors: [...refusals, EmptyProjectUpdate, ProjectGone, ProjectSlugTaken, BotNotPublic],
		changes: true,
	}),
	"projects.remove": OperationContract.make("projects.remove", {
		description:
			"Delete a project, with its chats, files, connectors, automations and computer. A recorded deletion resumes when the computer provider is reachable.",
		input: aProject,
		output: Schema.Void,
		errors: [...refusals, ComputerUnavailable, ComputerMadeMeanwhile, ClaimLost],
		changes: true,
	}),
	"projects.listMembers": OperationContract.make("projects.listMembers", {
		description: "List the members in a project, by name.",
		input: aProject,
		output: Schema.Array(projectMemberSchema),
		errors: reachRefusals,
		changes: false,
	}),
	"projects.listMembersReaching": OperationContract.make("projects.listMembersReaching", {
		description:
			"List the members who reach a project, by name: its members, or in a bot's own project, whoever can talk to the bot.",
		input: aProject,
		output: Schema.Array(memberParticipantSchema),
		errors: reachRefusals,
		changes: false,
	}),
	"projects.addMember": OperationContract.make("projects.addMember", {
		description: "Add a member of the workspace to a project.",
		input: Schema.Struct({ projectId: uuidSchema, ...newProjectMemberSchema.fields }),
		output: Schema.Void,
		errors: [...refusals, NotInWorkspace],
		changes: true,
	}),
	"projects.removeMember": OperationContract.make("projects.removeMember", {
		description:
			"Take a member out of a project. The workspace's owner and admins stay in every one.",
		input: Schema.Struct({ projectId: uuidSchema, memberId: uuidOrStringSchema }),
		output: Schema.Void,
		errors: [...refusals, AdministratorInEveryProject, NotInProject],
		changes: true,
	}),
	"projects.leave": OperationContract.make("projects.leave", {
		description:
			"Take yourself out of a project. The workspace's owner and admins stay in every one.",
		input: aProject,
		output: Schema.Void,
		errors: [...refusals, AdministratorInEveryProject, NotInProject],
		changes: true,
	}),
	"projects.join": OperationContract.make("projects.join", {
		description: "Put yourself in a public project, or for a bot, the member it acts for.",
		input: aProject,
		output: projectSchema,
		errors: [...workspaceRefusals, ...approvalAndFenceRefusals],
		changes: true,
	}),
	"projects.listBots": OperationContract.make("projects.listBots", {
		description: "List a project's bots, by name.",
		input: aProject,
		output: Schema.Array(botSchema),
		errors: reachRefusals,
		changes: false,
	}),
	"projects.addBot": OperationContract.make("projects.addBot", {
		description: "Add a public bot to a project, so members there can mention it.",
		input: Schema.Struct({
			projectId: projectIdSchema,
			botId: uuidSchema.annotate({ description: "The bot's id." }),
		}),
		output: Schema.Void,
		errors: [...refusals, BotNotPublic, ...approvalAndFenceRefusals],
		changes: true,
	}),
	"projects.removeBot": OperationContract.make("projects.removeBot", {
		description: "Take a bot out of a project. Its lead bot stays until another is chosen.",
		input: Schema.Struct({ projectId: uuidSchema, botId: uuidSchema }),
		output: Schema.Void,
		errors: [...refusals, LeadsProjects],
		changes: true,
	}),
} as const;

/**
 * Offered as `tool` only in member bounds, a personal bot's own turns,
 * where each call asks its creator: it changes who reaches what.
 */
const changesReachForMember = <const Tool extends string>(tool: Tool) =>
	({
		kind: "offered",
		tool,
		offeredIn: "memberBounds",
		approval: { kind: "always", approvers: "turn" },
	}) as const;

/** Held back: it changes who reaches the project, which a bot may only in member bounds. */
const changesWhoReaches = {
	kind: "heldBack",
	reason:
		"It changes who reaches the project, which a bot may do only in member bounds, and no tool does it yet.",
} as const;

export const projectsExposure = {
	"projects.list": {
		http: { kind: "offered", endpoint: "projects.list" },
		botLoop: {
			kind: "coveredBy",
			operation: "workspaces.guide",
			reason: "A Personal Assistant's workspace guide lists the projects its member sees.",
		},
	},
	"projects.create": {
		http: { kind: "offered", endpoint: "projects.create" },
		botLoop: changesReachForMember("create_project"),
	},
	"projects.update": {
		http: { kind: "offered", endpoint: "projects.update" },
		botLoop: {
			kind: "heldBack",
			reason:
				"No tool changes a project's settings, and its visibility and lead change who reaches it, which a bot may change only in member bounds.",
		},
	},
	"projects.remove": {
		http: { kind: "offered", endpoint: "projects.remove" },
		botLoop: {
			kind: "heldBack",
			reason:
				"Deleting a project deletes its chats, files and computer; members do it in the web app.",
		},
	},
	"projects.listMembers": {
		http: { kind: "offered", endpoint: "projects.listMembers" },
		botLoop: {
			kind: "heldBack",
			reason:
				"No tool lists a project's members; offering one waits for tools to become operations.",
		},
	},
	"projects.listMembersReaching": {
		http: { kind: "offered", endpoint: "projects.listMembersReaching" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It is who the web app's composer suggests for a mention before a chat has details; a bot mentions those it sees in the chat.",
		},
	},
	"projects.addMember": {
		http: { kind: "offered", endpoint: "projects.addMember" },
		botLoop: changesWhoReaches,
	},
	"projects.removeMember": {
		http: { kind: "offered", endpoint: "projects.removeMember" },
		botLoop: changesWhoReaches,
	},
	"projects.leave": {
		http: { kind: "offered", endpoint: "projects.leave" },
		botLoop: changesWhoReaches,
	},
	"projects.join": {
		http: { kind: "offered", endpoint: "projects.join" },
		botLoop: changesReachForMember("join_project"),
	},
	"projects.listBots": {
		http: { kind: "offered", endpoint: "projects.listBots" },
		botLoop: {
			kind: "heldBack",
			reason: "No tool lists a project's bots; offering one waits for tools to become operations.",
		},
	},
	"projects.addBot": {
		http: { kind: "offered", endpoint: "projects.addBot" },
		botLoop: changesReachForMember("add_bot_to_project"),
	},
	"projects.removeBot": {
		http: { kind: "offered", endpoint: "projects.removeBot" },
		botLoop: changesWhoReaches,
	},
} as const satisfies DomainExposure<typeof projectsContracts>;

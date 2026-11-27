/**
 * The projects operations' contracts, each with its decisions in the exposure manifest.
 * `index.ts` spreads them, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import { botSchema } from "../bots.ts";
import { ClaimLost, ComputerMadeMeanwhile, ComputerUnavailable } from "../errors/computers.ts";
import {
	AdministratorInEveryProject,
	BotNotPublic,
	EmptyProjectUpdate,
	LeadsProjects,
	NotInProject,
	NotInWorkspace,
	PersonalBotInProject,
	ProjectGone,
	ProjectHasPrivateBots,
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
		personalBotAsks: true,
	}) as const;

/** Held back: it changes who reaches the project, which a bot may only in member bounds. */
const changesWhoReaches = {
	kind: "heldBack",
	reason:
		"It changes who reaches the project, which a bot may do only in member bounds, and no tool does it yet.",
} as const;

export const projectsContracts = {
	"projects.list": OperationContract.make("projects.list", {
		description:
			"List the workspace's projects you are in, and the public ones you could join, by name.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema }),
		output: Schema.Array(projectSchema),
		errors: workspaceRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/workspaces/:workspace/projects" },
		botLoop: {
			kind: "coveredBy",
			operation: "workspaces.guide",
			reason: "A Personal Assistant's workspace guide lists the projects its member sees.",
		},
	}),
	"projects.create": OperationContract.make("projects.create", {
		description:
			"Make a project led by a bot you can talk to, with you in it, or for a bot, the member it acts for. A private bot leads only a private project, and a personal bot none. Public projects are listed for anyone in the workspace to join; private ones only for the members added. Its address is derived from its name unless you give one.",
		input: Schema.Struct({
			workspace: workspaceIdOrSlugSchema.annotate({
				description: "The workspace's id or address.",
			}),
			...newProjectSchema.fields,
		}),
		output: projectSchema,
		errors: [
			...workspaceRefusals,
			UnusableProjectName,
			ProjectSlugTaken,
			BotNotPublic,
			PersonalBotInProject,
			...approvalAndFenceRefusals,
		],
		changes: true,
		http: { kind: "offered", method: "POST", path: "/workspaces/:workspace/projects", status: 201 },
		botLoop: changesReachForMember("create_project"),
	}),
	"projects.update": OperationContract.make("projects.update", {
		description:
			"Change a project's name, address, colour, description, visibility or lead bot. A private project with private bots stays private until they leave; a private bot leads only a private project.",
		input: Schema.Struct({ projectId: uuidSchema, changes: projectUpdateSchema }),
		output: projectSchema,
		errors: [
			...refusals,
			EmptyProjectUpdate,
			ProjectGone,
			ProjectSlugTaken,
			BotNotPublic,
			PersonalBotInProject,
			ProjectHasPrivateBots,
		],
		changes: true,
		http: { kind: "offered", method: "PATCH", path: "/projects/:projectId" },
		botLoop: {
			kind: "heldBack",
			reason:
				"No tool changes a project's settings, and its visibility and lead change who reaches it, which a bot may change only in member bounds.",
		},
	}),
	"projects.remove": OperationContract.make("projects.remove", {
		description:
			"Delete a project, with its chats, files, connectors, automations and computer. A recorded deletion resumes when the computer provider is reachable.",
		input: aProject,
		output: Schema.Void,
		errors: [...refusals, ComputerUnavailable, ComputerMadeMeanwhile, ClaimLost],
		changes: true,
		http: { kind: "offered", method: "DELETE", path: "/projects/:projectId" },
		botLoop: {
			kind: "heldBack",
			reason:
				"Deleting a project deletes its chats, files and computer; members do it in the web app.",
		},
	}),
	"projects.listMembers": OperationContract.make("projects.listMembers", {
		description: "List the members in a project, by name.",
		input: aProject,
		output: Schema.Array(projectMemberSchema),
		errors: reachRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/projects/:projectId/members" },
		botLoop: {
			kind: "heldBack",
			reason:
				"No tool lists a project's members; offering one waits for tools to become operations.",
		},
	}),
	"projects.listMembersReaching": OperationContract.make("projects.listMembersReaching", {
		description:
			"List the members who reach a project, by name: its members, or in a bot's own project, whoever can talk to the bot.",
		input: aProject,
		output: Schema.Array(memberParticipantSchema),
		errors: reachRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/projects/:projectId/members-reaching" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It is who the web app's composer suggests for a mention before a chat has details; a bot mentions those it sees in the chat.",
		},
	}),
	"projects.addMember": OperationContract.make("projects.addMember", {
		description: "Add a member of the workspace to a project.",
		input: Schema.Struct({ projectId: uuidSchema, ...newProjectMemberSchema.fields }),
		output: Schema.Void,
		errors: [...refusals, NotInWorkspace],
		changes: true,
		http: { kind: "offered", method: "POST", path: "/projects/:projectId/members" },
		botLoop: changesWhoReaches,
	}),
	"projects.removeMember": OperationContract.make("projects.removeMember", {
		description:
			"Take a member out of a project. The workspace's owner and admins stay in every one.",
		input: Schema.Struct({ projectId: uuidSchema, memberId: uuidOrStringSchema }),
		output: Schema.Void,
		errors: [...refusals, AdministratorInEveryProject, NotInProject],
		changes: true,
		http: { kind: "offered", method: "DELETE", path: "/projects/:projectId/members/:memberId" },
		botLoop: changesWhoReaches,
	}),
	"projects.leave": OperationContract.make("projects.leave", {
		description:
			"Take yourself out of a project. The workspace's owner and admins stay in every one.",
		input: aProject,
		output: Schema.Void,
		errors: [...refusals, AdministratorInEveryProject, NotInProject],
		changes: true,
		http: { kind: "offered", method: "DELETE", path: "/projects/:projectId/membership" },
		botLoop: changesWhoReaches,
	}),
	"projects.join": OperationContract.make("projects.join", {
		description: "Put yourself in a public project, or for a bot, the member it acts for.",
		input: aProject,
		output: projectSchema,
		errors: [...workspaceRefusals, ...approvalAndFenceRefusals],
		changes: true,
		http: { kind: "offered", method: "PUT", path: "/projects/:projectId/membership" },
		botLoop: changesReachForMember("join_project"),
	}),
	"projects.listBots": OperationContract.make("projects.listBots", {
		description: "List a project's bots, by name.",
		input: aProject,
		output: Schema.Array(botSchema),
		errors: reachRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/projects/:projectId/bots" },
		botLoop: {
			kind: "heldBack",
			reason: "No tool lists a project's bots; offering one waits for tools to become operations.",
		},
	}),
	"projects.addBot": OperationContract.make("projects.addBot", {
		description:
			"Add a bot you can talk to to a project, so members there can mention it: a public bot to any project, a private bot to a private one.",
		input: Schema.Struct({
			projectId: projectIdSchema,
			botId: uuidSchema.annotate({ description: "The bot's id." }),
		}),
		output: Schema.Void,
		errors: [...refusals, BotNotPublic, PersonalBotInProject, ...approvalAndFenceRefusals],
		changes: true,
		http: { kind: "offered", method: "POST", path: "/projects/:projectId/bots" },
		botLoop: changesReachForMember("add_bot_to_project"),
	}),
	"projects.removeBot": OperationContract.make("projects.removeBot", {
		description: "Take a bot out of a project. Its lead bot stays until another is chosen.",
		input: Schema.Struct({ projectId: uuidSchema, botId: uuidSchema }),
		output: Schema.Void,
		errors: [...refusals, LeadsProjects],
		changes: true,
		http: { kind: "offered", method: "DELETE", path: "/projects/:projectId/bots/:botId" },
		botLoop: changesWhoReaches,
	}),
} as const;

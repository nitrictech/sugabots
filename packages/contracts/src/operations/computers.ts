/**
 * The computers operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import { UserText } from "@sugabots/errors";
import { Effect, Schema } from "effect";
import { attachmentNameSchema, MAX_ATTACHMENTS_PER_MESSAGE } from "../attachments.ts";
import {
	computerAccessSchema,
	computerHostSchema,
	computerNetworkSettingsSchema,
	computerProviderSchema,
	computerProviderUpdateSchema,
	computerTemplateSchema,
	HOST_REQUEST_TOOL,
	newComputerHostSchema,
	newComputerProviderSchema,
	projectComputerDiskSchema,
	projectComputerNetworkSchema,
	projectComputerSchema,
} from "../computer-providers.ts";
import {
	ClaimLost,
	ComputerHostBlocked,
	ComputerInUse,
	ComputerMadeMeanwhile,
	ComputerProviderBuiltInFixed,
	ComputerProviderIncomplete,
	ComputerProviderNotFound,
	ComputersNotDestroyed,
	ComputerUnavailable,
	DesktopUnavailable,
	NoComputer,
	NoComputerProvider,
	NoTemplates,
	UpgradeFailed,
} from "../errors/computers.ts";
import {
	ActionForbidden,
	ApprovalNeeded,
	ApprovalRefused,
	BotCannotReach,
	ResourceHidden,
	TurnEnded,
} from "../errors/proofs.ts";
import { UrlNotAllowed } from "../errors/providers.ts";
import { TurnExecutionSuperseded } from "../errors/turns.ts";
import { providerTestResultSchema } from "../model-providers.ts";
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

/** A workspace, by its id or its slug. */
const aWorkspace = Schema.Struct({ workspace: workspaceIdOrSlugSchema });

/** One of a workspace's computer providers. */
const aProvider = Schema.Struct({ workspace: workspaceIdOrSlugSchema, providerId: uuidSchema });

/** A host in a workspace's lists. */
const aWorkspaceHost = Schema.Struct({
	workspace: workspaceIdOrSlugSchema,
	...newComputerHostSchema.fields,
});

/** A project, by its id. */
const aProject = Schema.Struct({ projectId: uuidSchema });

/** A host in a project's list. */
const aProjectHost = Schema.Struct({ projectId: uuidSchema, host: computerHostSchema });

/**
 * A bot's desktop in a chat, open for its viewer: where the entrypoint
 * reaches the desktop's VNC server, and the password it signs in with for
 * the member, who never sees either; and whether they may take it over.
 */
const openDesktopSchema = Schema.Struct({
	endpoint: Schema.Struct({
		url: Schema.String,
		headers: Schema.Record(Schema.String, Schema.String),
	}),
	password: Schema.String,
	control: Schema.Boolean,
});

/**
 * The largest file a bot can share. It is read as the bots' user, through a
 * command that prints it as base64, which holds the whole file in the
 * server's memory on the way out.
 */
export const MAX_SHARED_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_SHARED_FILE_MEGABYTES = MAX_SHARED_FILE_BYTES / (1024 * 1024);

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
const MAX_COMMAND_TIMEOUT_SECONDS = 900;
const MAX_WRITTEN_CHARACTERS = 1_000_000;

/**
 * How a bot's use of its computer refuses: the chat's project out of reach,
 * a bot whose computer use is off or whose asker may change nothing there, a
 * workspace with no computer provider, a call still waiting for approval, and
 * a turn that has ended or been taken over.
 */
const computerUseRefusals = [
	ResourceHidden,
	BotCannotReach,
	ActionForbidden,
	NoComputerProvider,
	ApprovalNeeded,
	ApprovalRefused,
	TurnEnded,
	TurnExecutionSuperseded,
] as const;

/** What the bot is told when the computer couldn't do the work, as a result rather than a refusal. */
const computerFailedSchema = Schema.Struct({
	status: Schema.Literal("failed"),
	error: UserText.schema,
});

/** What the bot is told of how its computer came back, on the first call that finds out. */
const arrivalNote = { note: Schema.optional(UserText.schema) };

const computerPathSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(4_096),
).annotate({
	description: "A path on your computer, relative to this chat's folder unless it starts with /",
});

/** An image a result carries for the model to look at, base64. */
const shownImageSchema = Schema.Struct({ data: Schema.String, mediaType: Schema.String });

export const computersContracts = {
	"computers.viewDesktop": OperationContract.makeLongRunning("computers.viewDesktop", {
		description:
			"Watch a bot's desktop in this chat, or take it over where the member may change things. It stays open while they still may.",
		input: Schema.Struct({ chatId: uuidOrStringSchema, botId: uuidOrStringSchema }),
		output: openDesktopSchema,
		errors: [
			ResourceHidden,
			BotCannotReach,
			ActionForbidden,
			DesktopUnavailable,
			ComputerUnavailable,
		],
	}),
	"computerProviders.list": OperationContract.make("computerProviders.list", {
		description: "List the computer providers the workspace has set up, with their settings.",
		input: aWorkspace,
		output: Schema.Array(computerProviderSchema),
		errors: workspaceRefusals,
		changes: false,
	}),
	"computerProviders.access": OperationContract.make("computerProviders.access", {
		description:
			"Say whether the workspace's projects and bots can be given a computer: whether it has a computer provider enabled.",
		input: aWorkspace,
		output: computerAccessSchema,
		errors: workspaceRefusals,
		changes: false,
	}),
	"computerProviders.create": OperationContract.make("computerProviders.create", {
		description:
			"Set up a computer provider for the workspace. Enabling it disables whichever was enabled before.",
		input: Schema.Struct({
			workspace: workspaceIdOrSlugSchema,
			...newComputerProviderSchema.fields,
		}),
		output: computerProviderSchema,
		errors: [...workspaceRefusals, UrlNotAllowed, ComputerProviderIncomplete],
		changes: true,
	}),
	"computerProviders.update": OperationContract.make("computerProviders.update", {
		description:
			"Change a computer provider's settings or key, or enable it, which disables whichever was enabled before.",
		input: Schema.Struct({
			workspace: workspaceIdOrSlugSchema,
			providerId: uuidSchema,
			changes: computerProviderUpdateSchema,
		}),
		output: computerProviderSchema,
		errors: [
			...workspaceRefusals,
			ComputerProviderNotFound,
			UrlNotAllowed,
			ComputerProviderIncomplete,
			ComputerProviderBuiltInFixed,
		],
		changes: true,
	}),
	"computerProviders.remove": OperationContract.make("computerProviders.remove", {
		description:
			"Remove a computer provider, destroying the computers it made first. It is kept when they can't be destroyed.",
		input: aProvider,
		output: Schema.Void,
		errors: [
			...workspaceRefusals,
			ComputerProviderNotFound,
			ComputersNotDestroyed,
			ComputerMadeMeanwhile,
		],
		changes: true,
	}),
	"computerProviders.template": OperationContract.make("computerProviders.template", {
		description:
			"Say how a computer provider's template stands, for a provider that builds its computers from one.",
		input: aProvider,
		output: computerTemplateSchema,
		errors: [...workspaceRefusals, ComputerProviderNotFound, ComputerUnavailable],
		changes: false,
	}),
	"computerProviders.prepareTemplate": OperationContract.make("computerProviders.prepareTemplate", {
		description:
			"Start building a computer provider's template from Sugabots' computer image, in the workspace's own account.",
		input: aProvider,
		output: computerTemplateSchema,
		errors: [...workspaceRefusals, ComputerProviderNotFound, NoTemplates, ComputerUnavailable],
		changes: true,
	}),
	"computerProviders.test": OperationContract.make("computerProviders.test", {
		description:
			"Ask a computer provider whether it answers and accepts its key, and record how that went.",
		input: aProvider,
		output: providerTestResultSchema,
		errors: [...workspaceRefusals, ComputerProviderNotFound],
		changes: true,
	}),
	"computerProviders.disks": OperationContract.make("computerProviders.disks", {
		description:
			"Say how full the disks of the computers of the projects you reach are, of those measured.",
		input: aWorkspace,
		output: Schema.Array(projectComputerDiskSchema),
		errors: [ResourceHidden],
		changes: false,
	}),
	"computerProviders.network": OperationContract.make("computerProviders.network", {
		description:
			"Show which hosts every computer of the workspace may reach, and which none may: trusted, allowed and blocked hosts.",
		input: aWorkspace,
		output: computerNetworkSettingsSchema,
		errors: workspaceRefusals,
		changes: false,
	}),
	"computerProviders.addHost": OperationContract.make("computerProviders.addHost", {
		description: "Let every computer of the workspace reach a host.",
		input: aWorkspaceHost,
		output: computerNetworkSettingsSchema,
		errors: workspaceRefusals,
		changes: true,
	}),
	"computerProviders.removeHost": OperationContract.make("computerProviders.removeHost", {
		description: "Take a host off the hosts every computer of the workspace may reach.",
		input: aWorkspaceHost,
		output: computerNetworkSettingsSchema,
		errors: workspaceRefusals,
		changes: true,
	}),
	"computerProviders.blockHost": OperationContract.make("computerProviders.blockHost", {
		description: "Keep every computer of the workspace from reaching a host, whatever allows it.",
		input: aWorkspaceHost,
		output: computerNetworkSettingsSchema,
		errors: workspaceRefusals,
		changes: true,
	}),
	"computerProviders.unblockHost": OperationContract.make("computerProviders.unblockHost", {
		description: "Take a host off the workspace's blocked hosts.",
		input: aWorkspaceHost,
		output: computerNetworkSettingsSchema,
		errors: workspaceRefusals,
		changes: true,
	}),
	"projectComputer.get": OperationContract.make("projectComputer.get", {
		description: "Say how a project's computer stands, a bot's being its default project's.",
		input: aProject,
		output: projectComputerSchema,
		errors: reachRefusals,
		changes: false,
	}),
	"projectComputer.reset": OperationContract.make("projectComputer.reset", {
		description:
			"Destroy a project's computer and forget it, so its next use makes a new one. Refused while a bot uses it.",
		input: aProject,
		output: projectComputerSchema,
		errors: [...refusals, ClaimLost, ComputerInUse, ComputerUnavailable],
		changes: true,
	}),
	"projectComputer.upgrade": OperationContract.make("projectComputer.upgrade", {
		description:
			"Move a project's computer's work to a new computer made from the current image. Refused while a bot uses it.",
		input: aProject,
		output: projectComputerSchema,
		errors: [
			...refusals,
			NoComputerProvider,
			ClaimLost,
			ComputerInUse,
			NoComputer,
			UpgradeFailed,
			ComputerUnavailable,
		],
		changes: true,
	}),
	"projectComputer.network": OperationContract.make("projectComputer.network", {
		description:
			"Show which hosts a project's computer may reach: the workspace's, and those the project added.",
		input: aProject,
		output: projectComputerNetworkSchema,
		errors: reachRefusals,
		changes: false,
	}),
	"projectComputer.addHost": OperationContract.make("projectComputer.addHost", {
		description:
			"Let a project's computer reach a host, beyond what the workspace allows. A host the workspace blocked is refused.",
		input: Schema.Struct({ projectId: uuidSchema, ...newComputerHostSchema.fields }),
		output: projectComputerNetworkSchema,
		errors: [...refusals, ComputerHostBlocked],
		changes: true,
	}),
	"projectComputer.removeHost": OperationContract.make("projectComputer.removeHost", {
		description: "Take a host off the hosts a project's computer may reach beyond the workspace's.",
		input: aProjectHost,
		output: projectComputerNetworkSchema,
		errors: refusals,
		changes: true,
	}),
	"computers.runCommand": OperationContract.make("computers.runCommand", {
		description: `Run a bash command on your computer: the Linux machine of the project this chat is in, which its bots share. Commands start in this chat's folder, kept between your turns in the chat, so clone and build there; your home folder ($HOME) is kept across all your chats in the project, so keep notes, settings and tools you want everywhere there. The note on your computer names both, and says what is cleared when its disk runs short. Nothing else carries over between commands, so cd or export in the same command. Returns the exit code and the end of stdout and stderr. A command still running at its timeout is stopped. Your turn waits on every command, and no one hears from you until it ends, so keep waits short: sleep or poll for a few seconds while something starts up, never minutes for a member or another system to respond. When something will only be ready later, say what you're waiting for and end your turn. It can't ask a member anything, so pass flags that skip prompts. For web pages, use the browser_ tools. Commands run without a screen; when a chat needs one for something other than the browser, and the computer has sugabots-desktop, run "sugabots-desktop start" to get a desktop, set the DISPLAY it prints for the programs you start, and use scrot to take screenshots and xdotool to click and type. Stop it with "sugabots-desktop stop <number>" when you're done.`,
		input: Schema.Struct({
			command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
				description: "The bash command to run",
			}),
			timeout_seconds: Schema.Int.check(
				Schema.isBetween({ minimum: 1, maximum: MAX_COMMAND_TIMEOUT_SECONDS }),
			)
				.annotate({
					description: "How long it may run before it is stopped",
					default: DEFAULT_COMMAND_TIMEOUT_SECONDS,
				})
				.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_COMMAND_TIMEOUT_SECONDS))),
		}),
		output: Schema.Union([
			Schema.Struct({
				exitCode: Schema.Int,
				stdout: Schema.String,
				stderr: Schema.String,
				...arrivalNote,
			}),
			Schema.Struct({
				timedOut: Schema.Literal(true),
				stdout: Schema.String,
				stderr: Schema.String,
				...arrivalNote,
			}),
			computerFailedSchema,
		]),
		errors: computerUseRefusals,
		changes: true,
	}),
	"computers.readFile": OperationContract.make("computers.readFile", {
		description:
			"Read a file on your computer: a text file as text, or, when you can look at images, an image (PNG, JPEG, GIF or WebP), such as a screenshot. Long text files are cut off; use run_command with head, tail or grep for parts of them.",
		input: Schema.Struct({ path: computerPathSchema }),
		output: Schema.Union([
			Schema.Struct({
				content: Schema.String,
				truncated: Schema.optional(Schema.String),
				...arrivalNote,
			}),
			Schema.Struct({
				text: Schema.String,
				images: Schema.Array(shownImageSchema),
				...arrivalNote,
			}),
			computerFailedSchema,
		]),
		errors: computerUseRefusals,
		changes: false,
	}),
	"computers.writeFile": OperationContract.make("computers.writeFile", {
		description:
			"Write a text file on your computer, replacing it if it exists and making its directories.",
		input: Schema.Struct({
			path: computerPathSchema,
			content: Schema.String.check(Schema.isMaxLength(MAX_WRITTEN_CHARACTERS)).annotate({
				description: "The whole of the file's new content",
			}),
		}),
		output: Schema.Union([
			Schema.Struct({ written: Schema.String, ...arrivalNote }),
			computerFailedSchema,
		]),
		errors: computerUseRefusals,
		changes: true,
	}),
	"computers.copyChatFile": OperationContract.make("computers.copyChatFile", {
		description:
			"Copy a file in this chat, such as one a member attached, into the chat's folder on your computer, to work on it with commands. Give the file's id, from the line that names it. Returns the copy's path, relative to the chat's folder. A file already copied is left as it is, with any changes made to it, and `alreadyCopied` says so; to start again from the file in the chat, remove the copy and copy the file again.",
		input: Schema.Struct({
			file: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).annotate({
				description: "The file's id, from the line that names it",
			}),
		}),
		output: Schema.Union([
			Schema.Struct({ path: Schema.String, alreadyCopied: Schema.Boolean, ...arrivalNote }),
			computerFailedSchema,
		]),
		errors: computerUseRefusals,
		changes: true,
	}),
	"computers.shareFile": OperationContract.make("computers.shareFile", {
		description: `Share a file from your computer with everyone in this chat, such as a chart, picture or spreadsheet you made: it is attached to your reply as soon as you call this, an image shown as a picture and anything else offered to download. Never paste a file's contents, base64 or a link to it into your reply instead. Files up to ${MAX_SHARED_FILE_MEGABYTES} MB, at most ${MAX_ATTACHMENTS_PER_MESSAGE} on one reply.`,
		input: Schema.Struct({
			path: computerPathSchema,
			name: Schema.optional(
				attachmentNameSchema.annotate({
					description: "The name members see, such as chart.png. The file's own name unless given.",
				}),
			),
		}),
		output: Schema.Union([
			Schema.Struct({ shared: Schema.String, file: Schema.String, note: UserText.schema }),
			computerFailedSchema,
		]),
		errors: computerUseRefusals,
		// Part of the bot's own reply, as its text is: it changes nothing anyone else made.
		changes: false,
	}),
	"computers.useBrowser": OperationContract.make("computers.useBrowser", {
		description:
			"Use the browser the bot drives on its own desktop in its computer, in this chat, with one of the browser_ tools.",
		input: Schema.Struct({
			tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
			arguments: Schema.Record(Schema.String, Schema.Unknown),
		}),
		output: Schema.Union([
			Schema.Struct({
				text: Schema.String,
				images: Schema.optional(Schema.Array(shownImageSchema)),
			}),
			computerFailedSchema,
		]),
		errors: computerUseRefusals,
		changes: true,
	}),
	"computers.requestHost": OperationContract.make("computers.requestHost", {
		description:
			"Ask for your computer to be allowed to connect to a host it can't reach. Someone who manages this computer decides, and your reply waits until they have; once allowed, your computer reaches the host. Ask only for a host the chat needs, by its name, and use a wildcard such as *.example.com only when the chat needs many of a domain's subdomains. A host the workspace has blocked is refused at once.",
		input: Schema.Struct({
			host: computerHostSchema.annotate({
				description:
					"The host's name in lowercase, such as api.example.com; *.example.com covers its subdomains but not example.com itself",
			}),
		}),
		output: Schema.Union([
			Schema.Struct({
				status: Schema.Literal("allowed"),
				host: Schema.String,
				note: UserText.schema,
			}),
			computerFailedSchema,
		]),
		errors: [...computerUseRefusals, ComputerHostBlocked],
		changes: true,
	}),
} as const;

/** Held back: it manages the workspace, which a bot may do only in member bounds, and no tool does it yet. */
const managesWorkspace = {
	kind: "heldBack",
	reason:
		"It manages the workspace's computers, which a bot may do only in member bounds, and no tool does it yet.",
} as const;

/** Held back: it changes allowed hosts, which a bot may only in member bounds, and no tool does it yet. */
const changesAllowedHosts = {
	kind: "heldBack",
	reason:
		"It changes a project's allowed hosts, which a bot may do only in member bounds, and no tool does it yet. A bot asks for a host with its request_host tool, which its project's managers decide.",
} as const;

/** Held back: the note its computer tools write on each turn tells a bot this already. */
const toldEachTurn = <const What extends string>(what: What) =>
	({
		kind: "heldBack",
		reason: `A bot is told ${what} in the note on each turn that its computer tools write.`,
	}) as const;

/** Held back: a member reaches a computer through the desktop viewer, not through a bot's tools. */
const heldForBots = <const What extends string>(what: What) =>
	({
		kind: "heldBack",
		reason: `Only a bot works on a computer through ${what}; a member watches or takes over its desktop with computers.viewDesktop.`,
	}) as const;

/**
 * Offered as `tool` in every turn, which works on its chat's project's
 * computer when it may: it manages nothing. It waits for approval only where
 * a Personal Assistant's rule or an inherited one says so.
 */
const worksOnComputer = <const Tool extends string>(tool: Tool) =>
	({
		kind: "offered",
		tool,
		offeredIn: "everywhere",
		approval: { kind: "never" },
	}) as const;

export const computersExposure = {
	"computers.viewDesktop": {
		http: {
			kind: "heldBack",
			reason: "The desktop viewer's WebSocket opens it, and relays the desktop to the member.",
		},
		botLoop: {
			kind: "heldBack",
			reason: "A bot works on its computer through its computer tools, not a viewer.",
		},
	},
	"computerProviders.list": {
		http: { kind: "offered", endpoint: "computerProviders.list" },
		botLoop: managesWorkspace,
	},
	"computerProviders.access": {
		http: { kind: "offered", endpoint: "computerProviders.access" },
		botLoop: toldEachTurn("when it has no computer"),
	},
	"computerProviders.create": {
		http: { kind: "offered", endpoint: "computerProviders.create" },
		botLoop: managesWorkspace,
	},
	"computerProviders.update": {
		http: { kind: "offered", endpoint: "computerProviders.update" },
		botLoop: managesWorkspace,
	},
	"computerProviders.remove": {
		http: { kind: "offered", endpoint: "computerProviders.remove" },
		botLoop: managesWorkspace,
	},
	"computerProviders.template": {
		http: { kind: "offered", endpoint: "computerProviders.template" },
		botLoop: managesWorkspace,
	},
	"computerProviders.prepareTemplate": {
		http: { kind: "offered", endpoint: "computerProviders.prepareTemplate" },
		botLoop: managesWorkspace,
	},
	"computerProviders.test": {
		http: { kind: "offered", endpoint: "computerProviders.test" },
		botLoop: managesWorkspace,
	},
	"computerProviders.disks": {
		http: { kind: "offered", endpoint: "computerProviders.disks" },
		botLoop: toldEachTurn("when its computer's disk is nearly full"),
	},
	"computerProviders.network": {
		http: { kind: "offered", endpoint: "computerProviders.network" },
		botLoop: managesWorkspace,
	},
	"computerProviders.addHost": {
		http: { kind: "offered", endpoint: "computerProviders.addHost" },
		botLoop: managesWorkspace,
	},
	"computerProviders.removeHost": {
		http: { kind: "offered", endpoint: "computerProviders.removeHost" },
		botLoop: managesWorkspace,
	},
	"computerProviders.blockHost": {
		http: { kind: "offered", endpoint: "computerProviders.blockHost" },
		botLoop: managesWorkspace,
	},
	"computerProviders.unblockHost": {
		http: { kind: "offered", endpoint: "computerProviders.unblockHost" },
		botLoop: managesWorkspace,
	},
	"projectComputer.get": {
		http: { kind: "offered", endpoint: "projectComputer.get" },
		botLoop: {
			kind: "heldBack",
			reason:
				"How a computer stands is for the members looking after it; a bot works on its computer through its computer tools, which start or wake it as needed.",
		},
	},
	"projectComputer.reset": {
		http: { kind: "offered", endpoint: "projectComputer.reset" },
		botLoop: {
			kind: "heldBack",
			reason:
				"Resetting a computer throws away the work on it, the asking turn's included; members do it in the web app.",
		},
	},
	"projectComputer.upgrade": {
		http: { kind: "offered", endpoint: "projectComputer.upgrade" },
		botLoop: {
			kind: "heldBack",
			reason:
				"Upgrading moves a computer's work to a new one, which can't happen while a turn uses it, the asking turn's included; members do it in the web app.",
		},
	},
	"projectComputer.network": {
		http: { kind: "offered", endpoint: "projectComputer.network" },
		botLoop: toldEachTurn("which hosts its computer may reach"),
	},
	"projectComputer.addHost": {
		http: { kind: "offered", endpoint: "projectComputer.addHost" },
		botLoop: changesAllowedHosts,
	},
	"projectComputer.removeHost": {
		http: { kind: "offered", endpoint: "projectComputer.removeHost" },
		botLoop: changesAllowedHosts,
	},
	"computers.runCommand": {
		http: heldForBots("its terminal"),
		botLoop: worksOnComputer("run_command"),
	},
	"computers.readFile": {
		http: heldForBots("its files"),
		botLoop: worksOnComputer("read_file"),
	},
	"computers.writeFile": {
		http: heldForBots("its files"),
		botLoop: worksOnComputer("write_file"),
	},
	"computers.copyChatFile": {
		http: heldForBots("its files"),
		botLoop: worksOnComputer("copy_file_to_computer"),
	},
	"computers.shareFile": {
		http: {
			kind: "heldBack",
			reason: "A member attaches a file to their own message instead.",
		},
		botLoop: worksOnComputer("share_file"),
	},
	"computers.useBrowser": {
		http: heldForBots("its browser"),
		// One tool per browser action, each named browser_ and the action, as the
		// browser's own server lists them.
		botLoop: worksOnComputer("browser_*"),
	},
	"computers.requestHost": {
		http: {
			kind: "heldBack",
			reason:
				"Only a bot asks for a host; a member who may change the project's allowed hosts adds one with projectComputer.addHost.",
		},
		botLoop: {
			kind: "offered",
			tool: HOST_REQUEST_TOOL,
			offeredIn: "everywhere",
			approval: { kind: "always", approvers: "computerManagers" },
		},
	},
} as const satisfies DomainExposure<typeof computersContracts>;

/**
 * The computers operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import {
	computerAccessSchema,
	computerHostSchema,
	computerNetworkSettingsSchema,
	computerProviderSchema,
	computerProviderUpdateSchema,
	computerTemplateSchema,
	newComputerHostSchema,
	newComputerProviderSchema,
	projectComputerDiskSchema,
	projectComputerNetworkSchema,
	projectComputerSchema,
} from "../computer-providers.ts";
import {
	ComputerHostBlocked,
	ComputerInUse,
	ComputerMadeMeanwhile,
	ComputerProviderBuiltInFixed,
	ComputerProviderIncomplete,
	ComputerProviderNotFound,
	ComputersNotDestroyed,
	ComputerUnavailable,
	NoComputer,
	NoComputerProvider,
	NoTemplates,
	UpgradeFailed,
} from "../errors/computers.ts";
import { ActionForbidden, BotCannotReach, ResourceHidden } from "../errors/proofs.ts";
import { UrlNotAllowed } from "../errors/providers.ts";
import { providerTestResultSchema } from "../model-providers.ts";
import { uuidSchema } from "../uuid.ts";
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

export const computersContracts = {
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
		errors: [...refusals, ComputerInUse, ComputerUnavailable],
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

export const computersExposure = {
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
} as const satisfies DomainExposure<typeof computersContracts>;

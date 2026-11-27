import { Schema, Struct } from "effect";
import { emailSchema } from "./email.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Projects: long-running pieces of work where many members and many bots
 * talk, in the project's chats, each led by one lead bot.
 *
 * A project is reached by its members, and every workspace admin is one of
 * them. A public one is listed to everybody in the workspace to join; a
 * private one only to its members. Every bot also has a hidden default
 * project, where its own chats live, which is never listed: its chats are
 * reached through the bot.
 */

const ID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const slugSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(48),
	Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
		message: "Lower case letters, numbers and single hyphens",
	}),
);

/**
 * The stable address for a project, as it appears in a URL: a slug not shaped
 * like an id.
 *
 * It is unique within a workspace rather than across the server: two
 * workspaces may both have a `general`, and neither should have to know about
 * the other.
 */
export const projectSlugSchema = slugSchema.check(
	// An address takes an id or a slug in the same place, so a slug shaped like an id would be read as one.
	Schema.makeFilter((slug) => !ID_SHAPED.test(slug), { message: "Cannot be shaped like an id" }),
);

/**
 * The colours a project's tile can be, in the order a colour picker shows
 * them and new projects take them. Their own list rather than the bots' colours:
 * a tile fills its whole square, so its hues are spread evenly round the
 * wheel where the bots' have two blues an avatar can tell apart and a tile
 * cannot. Each names a tile palette; see `projectPalettes` in the web app's
 * `ProjectTile`.
 */
export const projectColors = [
	"green",
	"blue",
	"plum",
	"amber",
	"teal",
	"purple",
	"rose",
	"orange",
] as const;

const projectColorSchema = Schema.Literals(projectColors);

/** What a project is drawn in when it has no colour of its own stored. */
export const DEFAULT_PROJECT_COLOR = projectColors[0];

export type ProjectColor = typeof projectColorSchema.Type;

/**
 * The palette's first colour that the fewest of `taken` have, so a
 * workspace's projects go through every colour before any repeats. What a new project
 * is given when it names no colour, and what a form offers it first.
 */
export function leastUsedProjectColor(taken: readonly ProjectColor[]): ProjectColor {
	const uses = (color: ProjectColor) => taken.filter((one) => one === color).length;
	return projectColors.reduce((best, color) => (uses(color) < uses(best) ? color : best));
}

/**
 * What the caller may do in this project, already decided by the API.
 *
 * So a control nobody can use is not drawn at all: showing it and letting the
 * request fail teaches members that things here sometimes do not work. The API
 * remains the authority — these are answers it has given, not a check the
 * client performs.
 *
 * Every answer here accounts for the project's visibility and the caller's
 * membership as well as their role, so a client never has to pair one of these
 * with `visibility` or `isMember` to know whether to draw something.
 */
/**
 * What the member may do with what a project holds besides its members and
 * bots, the same on a project and on a bot, whose are its default
 * project's: its chats' history, settings, files, connectors, computer
 * and automations.
 */
export const resourcePermissionsSchema = Schema.Struct({
	/** Read its chats and what its automations' runs said, which managing them alone does not give. */
	readHistory: Schema.Boolean,
	/** Mark its chats resolved, and reopen them. A viewer reads and takes part, but changes neither. */
	resolveChats: Schema.Boolean,
	/** Open its settings: a bot's for whoever may change it, a project's for anyone in it. */
	openSettings: Schema.Boolean,
	/** Delete the files made in its chats. */
	deleteFiles: Schema.Boolean,
	/** Add, change, sign in and remove its connectors, its GitHub app among them. */
	manageConnectors: Schema.Boolean,
	/** Decide what its computer may reach, and reset and upgrade it. */
	manageComputer: Schema.Boolean,
	/** Click and type on its computer's desktop, rather than only watch it. */
	useDesktop: Schema.Boolean,
	/** Make, change and delete its automations, and rotate their webhook secrets. */
	manageAutomations: Schema.Boolean,
	/**
	 * Pause its automations: whoever manages them, and an admin on another
	 * member's personal bot, who may do nothing else with them.
	 */
	pauseAutomations: Schema.Boolean,
	/** Run its automations by hand. */
	runAutomations: Schema.Boolean,
});

export type ResourcePermissions = typeof resourcePermissionsSchema.Type;

export const projectPermissionsSchema = Schema.Struct({
	/** Change the project's name, address, colour, description, visibility and lead bot. */
	rename: Schema.Boolean,
	/** Invite and remove members. */
	manageMembers: Schema.Boolean,
	/** Add and remove bots, which must be public. */
	manageBots: Schema.Boolean,
	/** Take yourself out of the project. Never for an administrator, who is in every one. */
	leave: Schema.Boolean,
	/** Join it from the directory: a public project the member isn't in. */
	join: Schema.Boolean,
	delete: Schema.Boolean,
	resources: resourcePermissionsSchema,
});

export type ProjectPermissions = typeof projectPermissionsSchema.Type;

/** Whether a project is listed in the directory for anyone to join, or invitation-only. */
const projectVisibilitySchema = Schema.Literals(["public", "private"]);
export type ProjectVisibility = typeof projectVisibilitySchema.Type;

export const projectSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	name: Schema.String,
	slug: slugSchema,
	color: projectColorSchema,
	description: Schema.NullOr(Schema.String),
	visibility: projectVisibilitySchema,
	/**
	 * The bot that works on the project and answers its chats unless another
	 * is asked: one of its bots.
	 */
	leadBotId: uuidSchema,
	/** Whether the member asking is in it, rather than seeing it in the directory. */
	isMember: Schema.Boolean,
	/**
	 * How many members are in it, as its members list counts them. Given in the
	 * workspace's list of projects, for a project whose members the member may list.
	 */
	memberCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	/**
	 * How many bots are in it, as its bots list counts them. Given in the
	 * workspace's list of projects, for a project whose bots the member may list.
	 */
	botCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	permissions: projectPermissionsSchema,
	createdAt: isoTimestampSchema,
});

export type Project = typeof projectSchema.Type;

export const PROJECT_NAME_MAX_LENGTH = 64;

/** How long a project's description may be. */
export const PROJECT_DESCRIPTION_MAX_LENGTH = 280;

export const newProjectSchema = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(PROJECT_NAME_MAX_LENGTH)),
	/** Derived from the name when it is left out. */
	slug: Schema.optional(projectSlugSchema),
	/** The colour fewest of the workspace's projects have when it is left out. */
	color: Schema.optional(projectColorSchema),
	description: Schema.optional(
		Schema.NullOr(Schema.Trim.check(Schema.isMaxLength(PROJECT_DESCRIPTION_MAX_LENGTH))),
	),
	/** Public when left out. */
	visibility: Schema.optional(projectVisibilitySchema),
	/** The lead bot: a public bot, added to the project's bots if it is not one already. */
	leadBotId: uuidSchema,
});

export type NewProject = typeof newProjectSchema.Type;

export const projectUpdateSchema = newProjectSchema.mapFields(Struct.map(Schema.optional));

export type ProjectUpdate = typeof projectUpdateSchema.Type;

/** Somebody in a project. Every administrator is in every project members made. */
export const projectMemberSchema = Schema.Struct({
	memberId: uuidSchema,
	name: Schema.String,
	email: emailSchema,
	image: Schema.NullOr(Schema.String),
	/** Whether they can be taken out of this project. Never an administrator, who is in every one. */
	removable: Schema.Boolean,
});

export type ProjectMember = typeof projectMemberSchema.Type;

export const newProjectMemberSchema = Schema.Struct({
	memberId: uuidSchema,
});

/**
 * `Suga Team` becomes `suga-team`, and `Café` becomes `cafe`. Used for project
 * slugs, which the API derives when one is omitted, for workspace slugs on the
 * setup screen, and for handles.
 *
 * The trailing-hyphen strip turns twice on purpose: once before the length cap
 * and once after, because the cap can land mid-separator.
 */
export function slugify(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
}

import { Schema, Struct } from "effect";
import { namedMemberSchema } from "./api.ts";
import { resourcePermissionsSchema, slugify } from "./projects.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Bots: AI teammates, each with a name, handle, avatar, model and instructions.
 *
 * A bot belongs to its workspace. It is public, for everyone in the
 * workspace, or personal, for the member who made it, whose permissions it
 * acts with. A Personal Assistant is a personal bot. Public bots can be added
 * to projects.
 */

/**
 * The colours a bot's avatar can be, in the order a colour picker shows them:
 * round the hue wheel from red.
 * Each names a face, eye and bubble palette; see `botPalettes` in
 * `@sugabots/avatars`.
 */
export const botColors = [
	"red",
	"orange",
	"amber",
	"yellow",
	"lime",
	"green",
	"emerald",
	"teal",
	"sky",
	"ice",
	"indigo",
	"violet",
	"purple",
	"fuchsia",
	"pink",
	"rose",
] as const;

export const botColorSchema = Schema.Literals(botColors);

export type BotColor = typeof botColorSchema.Type;

/**
 * The eyes drawn on that colour, in the order an eye picker shows them.
 * Geometry rather than an upload, so a bot created at run time has an
 * avatar without anybody drawing one.
 */
export const botEyes = ["pill", "dot", "arc", "square", "wink"] as const;

export const botEyesSchema = Schema.Literals(botEyes);

export type BotEyes = typeof botEyesSchema.Type;

/**
 * The outline that colour fills, in the order a shape picker shows them. Like
 * the eyes, geometry the avatars package draws; a bot nobody gave a shape is a
 * circle.
 */
export const botShapes = [
	"circle",
	"squircle",
	"pebble",
	"blob",
	"wobble",
	"drop",
	"leaf",
	"dome",
	"bowl",
	"hexagon",
	"octagon",
	"triangle",
	"pentagon",
	"diamond",
	"shield",
	"star",
	"flower",
	"scallop",
	"ghost",
	"bear",
	"antenna",
] as const;

export const botShapeSchema = Schema.Literals(botShapes);

export type BotShape = typeof botShapeSchema.Type;

/**
 * An upstream model id. Provider configuration is the authority on whether it
 * may be selected; this only rejects values that cannot be sent safely.
 */
export const modelIdSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
	Schema.isPattern(/^[\w./:-]+$/, {
		message: "A model id may contain letters, numbers, dots, slashes, colons and dashes",
	}),
);

/**
 * How a bot is addressed in a message: `@trip-planner`. Lower case, so that
 * a mention typed by hand matches. Unique within the workspace, but for
 * Personal Assistants', which are unique only among one member's:
 * `@personal-assistant`, then `@personal-assistant-2`.
 */
export const handleSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(48),
	Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
		message: "Lower case letters, numbers and single hyphens",
	}),
);

/** The handle a bot or member gets from their name: `Personal Assistant` becomes `personal-assistant`. */
export function handleFromName(name: string): string {
	return slugify(name) || "bot";
}

/**
 * The system bots the product ships: bots the system calls rather than ones a
 * workspace writes. One of each per workspace, serving every bot in it.
 *
 * The keys live here so the API, the settings screens and a model test all
 * name the same system bot, and adding one is a compile error everywhere it has
 * to be handled rather than a string to remember.
 */
export const systemBotKeySchema = Schema.Literals(["compact"]);
export type SystemBotKey = typeof systemBotKeySchema.Type;

/** Whether everyone in the workspace sees a bot, or only the member who made it. */
const botVisibilitySchema = Schema.Literals(["public", "personal"]);
export type BotVisibility = typeof botVisibilitySchema.Type;

/** What the member asking may do with a bot, resolved by the API so a client never reasons about roles. */
export const botPermissionsSchema = Schema.Struct({
	/** Change its name, avatar, model, instructions, tools and visibility. */
	update: Schema.Boolean,
	delete: Schema.Boolean,
	/** Read and write in its chats. False for a personal bot an admin only sees listed. */
	talk: Schema.Boolean,
	/** What the member may do with what its default project holds. */
	resources: resourcePermissionsSchema,
});

export type BotPermissions = typeof botPermissionsSchema.Type;

export const botSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	name: Schema.String,
	handle: handleSchema,
	description: Schema.optional(Schema.NullOr(Schema.String)),
	color: botColorSchema,
	eyes: botEyesSchema,
	shape: botShapeSchema,
	/**
	 * Which model answers. `null` when nobody has chosen one, or somebody has
	 * cleared it — the bot's turns then refuse rather than run on a guess.
	 */
	model: Schema.optional(Schema.NullOr(modelIdSchema)),
	/** Who the bot is and how it works. Empty until somebody writes them. */
	instructions: Schema.optional(Schema.String),
	/**
	 * The built-in tools switched off for this bot, by key. A list of what is
	 * off rather than what is on, so a new built-in tool reaches every existing
	 * bot. Empty for a bot with everything.
	 */
	disabledTools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
	/**
	 * Whether it may run commands and edit files on its computer, while
	 * the workspace has a computer provider enabled. Off until its creator or an
	 * admin, who manage its computer, turns it on, unlike the other built-in
	 * tools, and only they may change it. Experimental.
	 */
	usesComputer: Schema.optional(Schema.Boolean),
	/**
	 * Whether it browses in a way members watching its desktop can follow: a
	 * cursor that moves to what it clicks, smooth scrolling, and typing at a
	 * typing pace. Slower, so off unless somebody turns it on, as for a demo.
	 */
	naturalBrowsing: Schema.optional(Schema.Boolean),
	/** Who added it, by name: null when nobody did, or they are no longer in the workspace. */
	createdBy: Schema.NullOr(namedMemberSchema),
	/** Whether everyone in the workspace sees it, or only its creator. */
	visibility: botVisibilitySchema,
	/**
	 * Whether it is a Personal Assistant: a personal bot, always, whose
	 * instructions Sugabots keeps. An administrator sees others' listed.
	 */
	assistant: Schema.Boolean,
	/** Whether the member asking pinned it to their sidebar. */
	pinned: Schema.Boolean,
	/**
	 * Its hidden default project, which holds its own chats, files,
	 * computer, connectors and automations: their routes are the project's.
	 */
	defaultProjectId: uuidSchema,
	permissions: botPermissionsSchema,
	createdAt: Schema.optional(isoTimestampSchema),
});

export type Bot = typeof botSchema.Type;

/** How long a bot's name may be. */
export const BOT_NAME_MAX_LENGTH = 64;

const nameSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(BOT_NAME_MAX_LENGTH),
);
const toolKeysSchema = Schema.mutable(
	Schema.Array(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
).check(Schema.isMaxLength(32), Schema.isUnique({ message: "Tool keys must be unique" }));

/** How long a bot's instructions may be. The settings page counts against it as you type. */
export const INSTRUCTIONS_MAX_LENGTH = 20_000;

/** How long a description may be: one or two lines, read by members and by other bots. */
export const DESCRIPTION_MAX_LENGTH = 280;

export const newBotSchema = Schema.Struct({
	name: nameSchema,
	/** Derived from the name when left out. */
	handle: Schema.optional(handleSchema),
	description: Schema.optional(
		Schema.NullOr(Schema.String.check(Schema.isMaxLength(DESCRIPTION_MAX_LENGTH))),
	),
	color: Schema.optional(botColorSchema),
	eyes: Schema.optional(botEyesSchema),
	shape: Schema.optional(botShapeSchema),
	model: modelIdSchema,
	instructions: Schema.optional(Schema.String.check(Schema.isMaxLength(INSTRUCTIONS_MAX_LENGTH))),
	disabledTools: Schema.optional(toolKeysSchema),
	usesComputer: Schema.optional(Schema.Boolean),
	naturalBrowsing: Schema.optional(Schema.Boolean),
	/** Public when left out. */
	visibility: Schema.optional(botVisibilitySchema),
});

export type NewBot = typeof newBotSchema.Type;

/** Everything its creator or an admin may change. */
export const botUpdateSchema = newBotSchema
	.mapFields(Struct.map(Schema.optional))
	// A model may be cleared, which creation has no use for: a bot is made
	// with one, and stops having one only when somebody takes it away.
	.mapFields(Struct.assign({ model: Schema.optional(Schema.NullOr(modelIdSchema)) }));

export type BotUpdate = typeof botUpdateSchema.Type;

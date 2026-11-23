import { Schema, Struct } from "effect";
import { namedPersonSchema } from "./api.ts";
import { resourcePermissionsSchema } from "./projects.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Bots: a configured model with a name, a face and a prompt.
 *
 * A bot belongs to its workspace. It is public, for everyone in the
 * workspace, or private, for the person who made it; a Personal Assistant is
 * its person's alone. Public bots can be added to projects.
 */

/**
 * The colours a bot's face can be, in the order a colour picker shows them:
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
export const botFaces = ["pill", "dot", "arc", "square", "wink"] as const;

export const botFaceSchema = Schema.Literals(botFaces);

export type BotFace = typeof botFaceSchema.Type;

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
 * How a bot is addressed in a message: `@personal-assistant`. Lower case,
 * so that a mention typed by hand matches, and unique within the workspace.
 */
export const handleSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(48),
	Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
		message: "Lower case letters, numbers and single hyphens",
	}),
);

/** The handle a bot or person gets from their name: `Personal Assistant` becomes `personal-assistant`. */
export function handleFromName(name: string): string {
	return (
		name
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48)
			.replace(/-+$/g, "") || "bot"
	);
}

/**
 * The system bots the product ships: bots the system calls rather than ones a
 * workspace writes. One of each per workspace, serving every bot in it.
 *
 * The keys live here so the API, the settings screens and a model trial all
 * name the same system bot, and adding one is a compile error everywhere it has
 * to be handled rather than a string to remember.
 */
export const systemBotKeySchema = Schema.Literals(["compact"]);
export type SystemBotKey = typeof systemBotKeySchema.Type;

/** Whether everyone in the workspace sees a bot, or only the person who made it. */
const botVisibilitySchema = Schema.Literals(["public", "private"]);
export type BotVisibility = typeof botVisibilitySchema.Type;

/** What the person asking may do with a bot, resolved by the API so a client never reasons about roles. */
export const botPermissionsSchema = Schema.Struct({
	/** Change its name, look, model, instructions, tools and visibility. */
	update: Schema.Boolean,
	delete: Schema.Boolean,
	/** Read and write in its threads. False for a private bot an admin only sees listed. */
	talk: Schema.Boolean,
	/** What the person may do with what its default project holds. */
	resources: resourcePermissionsSchema,
});

export type BotPermissions = typeof botPermissionsSchema.Type;

export const botSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	name: Schema.String,
	handle: handleSchema,
	description: Schema.NullOr(Schema.String),
	color: botColorSchema,
	face: botFaceSchema,
	shape: botShapeSchema,
	/**
	 * Which model answers. `null` when nobody has chosen one, or somebody has
	 * cleared it — the bot's turns then refuse rather than run on a guess.
	 */
	model: Schema.NullOr(modelIdSchema),
	/** The system prompt. Empty until somebody writes one. */
	prompt: Schema.String,
	/**
	 * The built-in tools switched off for this bot, by key. A list of what is
	 * off rather than what is on, so a new built-in tool reaches every existing
	 * bot. Empty for a bot with everything.
	 */
	disabledTools: Schema.mutable(Schema.Array(Schema.String)),
	/**
	 * Whether it may run commands and edit files on its computer, while
	 * the workspace has a computer provider enabled. Off until its creator or an
	 * admin, who manage its computer, turns it on, unlike the other built-in
	 * tools, and only they may change it. Experimental.
	 */
	usesComputer: Schema.Boolean,
	/**
	 * Whether it browses in a way people watching its desktop can follow: a
	 * cursor that moves to what it clicks, smooth scrolling, and typing at a
	 * typing pace. Slower, so off unless somebody turns it on, as for a demo.
	 */
	naturalBrowsing: Schema.Boolean,
	/** Who added it, by name: null when nobody did, or they are no longer in the workspace. */
	createdBy: Schema.NullOr(namedPersonSchema),
	/**
	 * Whether everyone in the workspace sees it, or only its creator.
	 * Meaningless when `assistant` is true: a Personal Assistant is neither
	 * public nor private, as only its person ever sees it.
	 */
	visibility: botVisibilitySchema,
	/** Whether it is the person's own Personal Assistant, which only they see. */
	assistant: Schema.Boolean,
	/** Whether the person asking pinned it to their sidebar. */
	pinned: Schema.Boolean,
	/**
	 * Its hidden default project, which holds its own threads, files,
	 * computer, connections and automations: their routes are the project's.
	 */
	defaultProjectId: uuidSchema,
	permissions: botPermissionsSchema,
	createdAt: isoTimestampSchema,
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

/** How long a prompt may be. The settings page counts against it as you type. */
export const PROMPT_MAX_LENGTH = 20_000;

/** How long a description may be: one or two lines, read by people and by other bots. */
export const DESCRIPTION_MAX_LENGTH = 280;

export const newBotSchema = Schema.Struct({
	name: nameSchema,
	/** Derived from the name when left out. */
	handle: Schema.optional(handleSchema),
	description: Schema.optional(
		Schema.NullOr(Schema.String.check(Schema.isMaxLength(DESCRIPTION_MAX_LENGTH))),
	),
	color: Schema.optional(botColorSchema),
	face: Schema.optional(botFaceSchema),
	shape: Schema.optional(botShapeSchema),
	model: modelIdSchema,
	prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(PROMPT_MAX_LENGTH))),
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

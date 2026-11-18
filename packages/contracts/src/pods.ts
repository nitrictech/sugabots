import { Schema, Struct } from "effect";
import { emailSchema } from "./email.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Channels (still `pod` in code): long-running projects where many people
 * and many bots talk, in a main chat and threads.
 *
 * A channel is reached by its members, and every workspace admin is one of
 * them. A public one is listed to everybody in the workspace to join; a
 * private one only to its members.
 */

/**
 * The stable address for a channel, as it appears in a URL.
 *
 * It is unique within a workspace rather than across the
 * installation: two workspaces may both have a `general`, and neither should
 * have to know about the other.
 */
const ID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const podSlugSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(48),
	Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
		message: "Lower case letters, numbers and single hyphens",
	}),
);

/** A slug a channel may take: not one shaped like an id. */
export const sharedPodSlugSchema = podSlugSchema.check(
	// An address takes an id or a slug in the same place, so a slug shaped like an id would be read as one.
	Schema.makeFilter((slug) => !ID_SHAPED.test(slug), { message: "Cannot be shaped like an id" }),
);

/**
 * The colours a shared pod's tile can be, in the order a colour picker shows
 * them and new pods take them. Their own list rather than the bots' colours:
 * a tile fills its whole square, so its hues are spread evenly round the
 * wheel where the bots' have two blues a face can tell apart and a tile
 * cannot. Each names a tile palette; see `podPalettes` in the web app's
 * `PodTile`.
 */
export const podColors = [
	"green",
	"blue",
	"plum",
	"amber",
	"teal",
	"purple",
	"rose",
	"orange",
] as const;

export const podColorSchema = Schema.Literals(podColors);

/** What a shared pod is drawn in when it has no colour of its own stored. */
export const DEFAULT_POD_COLOR = podColors[0];

export type PodColor = typeof podColorSchema.Type;

/**
 * The palette's first colour that the fewest of `taken` have, so a
 * workspace's pods go through every colour before any repeats. What a new pod
 * is given when it names no colour, and what a form offers it first.
 */
export function leastUsedPodColor(taken: readonly (PodColor | null)[]): PodColor {
	const uses = (color: PodColor) => taken.filter((one) => one === color).length;
	return podColors.reduce((best, color) => (uses(color) < uses(best) ? color : best));
}

/**
 * What the caller may do in this pod, already decided by the API.
 *
 * So a control nobody can use is not drawn at all: showing it and letting the
 * request fail teaches people that things here sometimes do not work. The API
 * remains the authority — these are answers it has given, not a check the
 * client performs.
 *
 * Every answer here accounts for the pod's kind as well as the caller's role,
 * so a client never has to pair one of these with `kind === "shared"` to know
 * whether to draw something.
 */
export const podPermissionsSchema = Schema.Struct({
	/** Change the channel's name, address, colour, description and visibility. */
	rename: Schema.Boolean,
	/** Invite and remove people. */
	manageMembers: Schema.Boolean,
	/** Add and remove bots, which must be public. */
	manageBots: Schema.Boolean,
	/** Take yourself out of the channel. Never for an administrator, who is in every one. */
	leave: Schema.Boolean,
	/** Join it from the directory: a public channel the person isn't in. */
	join: Schema.Boolean,
	delete: Schema.Boolean,
	/** Delete the files its bots made in it. */
	deleteArtifacts: Schema.Boolean,
});

export type PodPermissions = typeof podPermissionsSchema.Type;

/** Whether a channel is listed in the directory for anyone to join, or invitation-only. */
export const podVisibilitySchema = Schema.Literals(["public", "private"]);
export type PodVisibility = typeof podVisibilitySchema.Type;

export const podSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	name: Schema.String,
	slug: podSlugSchema,
	/** `null` for the default colour. */
	color: Schema.NullOr(podColorSchema),
	description: Schema.NullOr(Schema.String),
	visibility: podVisibilitySchema,
	/** Whether the person asking is in it, rather than seeing it in the directory. */
	isMember: Schema.Boolean,
	permissions: podPermissionsSchema,
	createdAt: isoTimestampSchema,
});

export type Pod = typeof podSchema.Type;

export const POD_NAME_MAX_LENGTH = 64;

/** How long a channel's description may be. */
export const POD_DESCRIPTION_MAX_LENGTH = 280;

export const newPodSchema = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(POD_NAME_MAX_LENGTH)),
	/** Derived from the name when it is left out. */
	slug: Schema.optional(sharedPodSlugSchema),
	/** The colour fewest of the workspace's channels have when it is left out. */
	color: Schema.optional(podColorSchema),
	description: Schema.optional(
		Schema.NullOr(Schema.Trim.check(Schema.isMaxLength(POD_DESCRIPTION_MAX_LENGTH))),
	),
	/** Public when left out. */
	visibility: Schema.optional(podVisibilitySchema),
});

export type NewPod = typeof newPodSchema.Type;

export const podUpdateSchema = newPodSchema.mapFields(Struct.map(Schema.optional));

export type PodUpdate = typeof podUpdateSchema.Type;

/** Somebody in a pod. Every administrator is in every shared pod. */
export const podMemberSchema = Schema.Struct({
	userId: uuidSchema,
	name: Schema.String,
	email: emailSchema,
	image: Schema.NullOr(Schema.String),
	addedAt: isoTimestampSchema,
	/** Whether they can be taken out of this channel. Never an administrator, who is in every one. */
	removable: Schema.Boolean,
});

export type PodMember = typeof podMemberSchema.Type;

export const newPodMemberSchema = Schema.Struct({
	userId: uuidSchema,
});

/**
 * `Suga Team` becomes `suga-team`. Used for pod slugs, which the API
 * derives when one is omitted, and for workspace slugs on the setup screen.
 *
 * The trailing-hyphen strip turns twice on purpose: once before the length cap
 * and once after, because the cap can land mid-separator.
 */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
}

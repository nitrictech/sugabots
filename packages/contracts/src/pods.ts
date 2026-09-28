import { Schema, Struct } from "effect";
import { emailSchema } from "./email.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Pods: a folder of agents plus the people who can reach into it.
 *
 * A shared pod is reached by its members, and every workspace admin is one of
 * them. A Personal pod is reached by its owner and by nobody else, admins
 * included. `docs/permissions.md` is the
 * specification.
 */

/**
 * The stable address for a pod, as it appears in a URL.
 *
 * A shared pod's is unique within a workspace rather than across the
 * installation: two workspaces may both have a `general`, and neither should
 * have to know about the other.
 */
export const podSlugSchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(48),
	Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
		message: "Lower case letters, numbers and single hyphens",
	}),
);

/**
 * Every Personal pod's slug. Nobody reaches a Personal pod but its owner, so
 * within what one person can see it names exactly one pod: their own.
 */
export const PERSONAL_POD_SLUG = "personal";

/** A slug a shared pod may take: any but the one every Personal pod answers to. */
export const sharedPodSlugSchema = podSlugSchema.check(
	Schema.makeFilter((slug) => slug !== PERSONAL_POD_SLUG, {
		message: `"${PERSONAL_POD_SLUG}" is reserved for Personal pods`,
	}),
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

/** Whether the Facilitator chooses speakers in non-chat threads (ADR 004). */
export const podRoutingSchema = Schema.Struct({
	facilitator: Schema.Boolean,
});

export type PodRouting = typeof podRoutingSchema.Type;

export const DEFAULT_POD_ROUTING: PodRouting = { facilitator: false };

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
	/** Change the pod's name, address and colour. Never on a Personal pod, which keeps all three. */
	rename: Schema.Boolean,
	changeRouting: Schema.Boolean,
	/** Add and remove members. Never on a Personal pod, which is one person's. */
	manageMembers: Schema.Boolean,
	/** Take yourself out of the pod. Never for an administrator, who is in every shared pod. */
	leave: Schema.Boolean,
	createAgents: Schema.Boolean,
	updateAgents: Schema.Boolean,
	deleteAgents: Schema.Boolean,
	manageConnections: Schema.Boolean,
	/** Add, change and remove Routines, and rotate their webhook secrets. */
	manageRoutines: Schema.Boolean,
	runRoutines: Schema.Boolean,
});

export type PodPermissions = typeof podPermissionsSchema.Type;

export const podSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	/** Whose Personal pod this is. `null` on a shared pod, which has no owner. */
	ownerId: Schema.NullOr(uuidSchema),
	kind: Schema.Literals(["personal", "shared"]),
	name: Schema.String,
	slug: podSlugSchema,
	/** `null` on a Personal pod, which is drawn as its lock rather than a tile. */
	color: Schema.NullOr(podColorSchema),
	routing: podRoutingSchema,
	permissions: podPermissionsSchema,
	createdAt: isoTimestampSchema,
});

export type Pod = typeof podSchema.Type;

export const newPodSchema = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
	/** Derived from the name when it is left out. */
	slug: Schema.optional(sharedPodSlugSchema),
	/** The colour fewest of the workspace's pods have when it is left out. */
	color: Schema.optional(podColorSchema),
});

export type NewPod = typeof newPodSchema.Type;

export const podUpdateSchema = newPodSchema
	.mapFields(Struct.map(Schema.optional))
	.mapFields(Struct.assign({ routing: Schema.optional(podRoutingSchema) }));

export type PodUpdate = typeof podUpdateSchema.Type;

/** Somebody in a pod. Every administrator is in every shared pod. */
export const podMemberSchema = Schema.Struct({
	userId: uuidSchema,
	name: Schema.String,
	email: emailSchema,
	image: Schema.NullOr(Schema.String),
	addedAt: isoTimestampSchema,
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

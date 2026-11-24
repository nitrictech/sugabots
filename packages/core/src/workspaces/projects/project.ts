import {
	DEFAULT_PROJECT_COLOR,
	newProjectSchema,
	type Project,
	type ProjectColor,
	type ProjectPermissions,
	projectSlugSchema,
	slugify,
} from "@sugabots/contracts";
import { InvalidProjectDetails, UnusableProjectName } from "@sugabots/contracts/errors/projects";
import { Effect, Schema } from "effect";
import type { ProjectStanding } from "../../authorization/access.ts";
import {
	type Actor,
	type ProjectFacts,
	projectPermissions,
} from "../../authorization/permissions.ts";
import type * as schema from "../../database/schema.ts";

/** The row as the API returns it: timestamps as ISO strings, no internals. */
function toProject(
	row: schema.ProjectRow,
	isMember: boolean,
	permissions: ProjectPermissions,
): Project {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		name: row.name,
		slug: row.slug,
		color: projectColorOf(row.color),
		description: row.description,
		visibility: row.visibility,
		leadBotId: row.leadBotId,
		isMember,
		permissions,
		createdAt: row.createdAt.toISOString(),
	};
}

/**
 * The project as one member sees it, permissions and all.
 *
 * Takes a standing rather than a project and a member, so the permissions on
 * it are always the ones the caller who asked for it holds.
 */
export function projectSeenBy({ project: row, actor, facts }: ProjectStanding): Project {
	return projectSeenAs(row, actor, facts);
}

/**
 * The project as `actor` sees it, permissions and all, from whether they are
 * in it and the bot whose default project it is.
 */
export function projectSeenAs(row: schema.ProjectRow, actor: Actor, facts: ProjectFacts): Project {
	return toProject(
		row,
		facts.isMember,
		projectPermissions(actor, { ...facts, isPublic: row.visibility === "public" }),
	);
}

/** A project's stored colour, or the default when it has none. */
export function projectColorOf(stored: ProjectColor | null): ProjectColor {
	return stored ?? DEFAULT_PROJECT_COLOR;
}

/** A project's name and description, as every caller must give them. */
const projectDetailsSchema = Schema.Struct({
	name: newProjectSchema.fields.name,
	description: newProjectSchema.fields.description,
});

/**
 * A new project's name and description checked, and its address: `slug`, or
 * one derived from its name when that is left out. Checked here, not only by
 * the HTTP API, for callers that don't come through it, and before anything is
 * written, so a name such as "!!!" is refused for the name rather than as a
 * taken address.
 */
export const newProjectDetails = (input: {
	readonly name: string;
	readonly description?: string | null | undefined;
	readonly slug?: string | undefined;
}) =>
	Effect.gen(function* () {
		const details = yield* Schema.decodeEffect(projectDetailsSchema)({
			name: input.name,
			description: input.description,
		}).pipe(Effect.mapError(() => new InvalidProjectDetails()));
		const slug = yield* Schema.decodeEffect(projectSlugSchema)(
			input.slug ?? slugify(details.name),
		).pipe(Effect.mapError(() => new UnusableProjectName()));
		return { ...details, slug };
	});

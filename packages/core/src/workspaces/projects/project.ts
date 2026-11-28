import {
	type BotVisibility,
	DEFAULT_PROJECT_COLOR,
	type Project,
	type ProjectColor,
	type ProjectPermissions,
	type ProjectVisibility,
	projectSlugSchema,
	slugify,
} from "@sugabots/contracts";
import {
	BotNotPublic,
	PersonalBotInProject,
	UnusableProjectName,
} from "@sugabots/contracts/errors/projects";
import { Effect, Schema } from "effect";
import type * as schema from "../../database/schema.ts";
import type { MemberPlace, ProjectFacts } from "../../proofs/facts.ts";
import { projectPermissionsShown } from "../../proofs/shown-permissions.ts";

export function checkProjectBotVisibility(
	botVisibility: BotVisibility | undefined,
	projectVisibility: ProjectVisibility = "public",
) {
	if (botVisibility === undefined || botVisibility === "personal")
		return Effect.fail(new PersonalBotInProject());
	if (botVisibility === "private" && projectVisibility === "public")
		return Effect.fail(new BotNotPublic());
	return Effect.void;
}

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
 * The project, one members made, as the member at `place` sees it,
 * permissions and all.
 */
export function projectSeenAs(row: schema.ProjectRow, place: MemberPlace): Project {
	return toProject(row, place.inProject, projectPermissionsShown(place, projectFactsOf(row)));
}

/** The facts of `row`, a project members made, as the provers decide from them. */
export function projectFactsOf(row: schema.ProjectRow): ProjectFacts {
	return {
		id: row.id,
		workspace: row.workspaceId,
		leadBot: row.leadBotId,
		visibility: row.visibility,
		defaultOf: null,
	};
}

/** A project's stored colour, or the default when it has none. */
export function projectColorOf(stored: ProjectColor | null): ProjectColor {
	return stored ?? DEFAULT_PROJECT_COLOR;
}

/**
 * A new project's address: `slug`, or one derived from its name when that is
 * left out, checked before anything is written, so a name such as "!!!" is
 * refused for the name rather than as a taken address.
 */
export const newProjectSlug = (input: {
	readonly name: string;
	readonly slug?: string | undefined;
}) =>
	Schema.decodeEffect(projectSlugSchema)(input.slug ?? slugify(input.name)).pipe(
		Effect.mapError(() => new UnusableProjectName()),
	);

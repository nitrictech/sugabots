import {
	DEFAULT_PROJECT_COLOR,
	type Project,
	type ProjectColor,
	type ProjectPermissions,
} from "@sugabots/contracts";
import type { ProjectStanding } from "../../authorization/access.ts";
import { projectPermissions } from "../../authorization/permissions.ts";
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

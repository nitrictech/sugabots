import {
	DEFAULT_POD_COLOR,
	type Pod,
	type PodColor,
	type PodPermissions,
} from "@sugabots/contracts";
import type { PodStanding } from "../../authorization/access.ts";
import { podPermissions } from "../../authorization/permissions.ts";
import type * as schema from "../../database/schema.ts";

/** The row as the API returns it: timestamps as ISO strings, no internals. */
function toPod(row: schema.PodRow, isMember: boolean, permissions: PodPermissions): Pod {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		name: row.name,
		slug: row.slug,
		color: podColorOf(row.color),
		description: row.description,
		visibility: row.visibility,
		isMember,
		permissions,
		createdAt: row.createdAt.toISOString(),
	};
}

/**
 * The channel as one person sees it, permissions and all.
 *
 * Takes a standing rather than a channel and a person, so the permissions on
 * it are always the ones the caller who asked for it holds.
 */
export function podSeenBy({ pod: row, actor, facts }: PodStanding): Pod {
	return toPod(
		row,
		facts.isMember,
		podPermissions(actor, { ...facts, isPublic: row.visibility === "public" }),
	);
}

/** A channel's stored colour, or the default when it has none. */
export function podColorOf(stored: PodColor | null): PodColor {
	return stored ?? DEFAULT_POD_COLOR;
}

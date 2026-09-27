import {
	DEFAULT_POD_COLOR,
	type Pod,
	type PodColor,
	type PodPermissions,
} from "@sugabots/contracts";
import type * as schema from "../../database/schema.ts";
import type { PodStanding } from "../access.ts";
import { podPermissions } from "../permissions.ts";

/** The row as the API returns it: timestamps as ISO strings, no internals. */
export function toPod(row: schema.PodRow, permissions: PodPermissions): Pod {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		ownerId: row.ownerId,
		kind: row.kind,
		name: row.name,
		slug: row.slug,
		color: row.kind === "shared" ? podColorOf(row.color) : null,
		routing: row.routing,
		permissions,
		createdAt: row.createdAt.toISOString(),
	};
}

/**
 * The pod as one person sees it, permissions and all.
 *
 * Takes a standing rather than a pod and a person, so the permissions on a pod
 * are always the ones the caller who asked for it holds.
 */
export function podSeenBy({ pod: row, actor, facts }: PodStanding): Pod {
	return toPod(row, podPermissions(actor, facts));
}

/** A shared pod's stored colour, or the default when it has none. */
export function podColorOf(stored: PodColor | null): PodColor {
	return stored ?? DEFAULT_POD_COLOR;
}

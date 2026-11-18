import {
	type Channel,
	type ChannelColor,
	type ChannelPermissions,
	DEFAULT_CHANNEL_COLOR,
} from "@sugabots/contracts";
import type { ChannelStanding } from "../../authorization/access.ts";
import { channelPermissions } from "../../authorization/permissions.ts";
import type * as schema from "../../database/schema.ts";

/** The row as the API returns it: timestamps as ISO strings, no internals. */
function toChannel(
	row: schema.ChannelRow,
	isMember: boolean,
	permissions: ChannelPermissions,
): Channel {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		name: row.name,
		slug: row.slug,
		color: channelColorOf(row.color),
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
export function channelSeenBy({ channel: row, actor, facts }: ChannelStanding): Channel {
	return toChannel(
		row,
		facts.isMember,
		channelPermissions(actor, { ...facts, isPublic: row.visibility === "public" }),
	);
}

/** A channel's stored colour, or the default when it has none. */
export function channelColorOf(stored: ChannelColor | null): ChannelColor {
	return stored ?? DEFAULT_CHANNEL_COLOR;
}

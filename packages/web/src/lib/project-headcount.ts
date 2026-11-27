import { formatCount } from "@/lib/name-list.ts";

/**
 * Who is in a project, as its pages say it: "3 members, 2 bots". Either count
 * is left out until it is known, so a loading roster never reads 0.
 */
export function projectHeadcount({
	members,
	bots,
}: {
	members: number | undefined;
	bots: number | undefined;
}) {
	return [
		members === undefined ? undefined : formatCount(members, "member", "members"),
		bots === undefined ? undefined : formatCount(bots, "bot", "bots"),
	]
		.filter(Boolean)
		.join(", ");
}

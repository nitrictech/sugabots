import { countOf } from "@/lib/name-list.ts";

/**
 * Who is in a project, as its pages say it: "3 people, 2 bots". Either count
 * is left out until it is known, so a loading roster never reads 0.
 */
export function projectHeadcount({
	people,
	bots,
}: {
	people: number | undefined;
	bots: number | undefined;
}) {
	return [
		people === undefined ? undefined : countOf(people, "person", "people"),
		bots === undefined ? undefined : countOf(bots, "bot", "bots"),
	]
		.filter(Boolean)
		.join(", ");
}

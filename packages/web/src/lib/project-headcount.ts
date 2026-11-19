import { countOf } from "@/lib/name-list.ts";

/**
 * Who is in a project, as its pages say it: "3 people, 2 bots". The people
 * are left out until their count is known, so a loading roster never reads 0.
 */
export function projectHeadcount({ people, bots }: { people: number | undefined; bots: number }) {
	return [
		people === undefined ? undefined : countOf(people, "person", "people"),
		countOf(bots, "bot", "bots"),
	]
		.filter(Boolean)
		.join(", ");
}

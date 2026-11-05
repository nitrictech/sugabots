import type { Liveliness } from "./liveliness.ts";
import type { Span } from "./random.ts";

/** How the faces in a `LivelyGroup` take turns to move. */
export interface GroupPacing {
	/** How many faces may move at once. */
	movingAtOnce: number;
	/** Seconds between turns starting, and how long a turn lasts, each picked at random from its range. */
	gapSeconds: Span;
	turnSeconds: Span;
}

export const pacingByLiveliness: Record<Exclude<Liveliness, "off">, GroupPacing> = {
	sometimes: {
		movingAtOnce: 1,
		gapSeconds: { least: 4, most: 10 },
		turnSeconds: { least: 1, most: 3 },
	},
	often: {
		movingAtOnce: 2,
		gapSeconds: { least: 1.5, most: 4 },
		turnSeconds: { least: 1.5, most: 4 },
	},
};

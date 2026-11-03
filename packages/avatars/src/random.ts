/** A span from `least` to `most`, of seconds or a size, that something is picked from at random. */
export interface Span {
	least: number;
	most: number;
}

/** A number picked at random, evenly, from `span`. */
export function randomIn({ least, most }: Span): number {
	return least + Math.random() * (most - least);
}

/**
 * Runs `act` again and again, waiting a number of seconds picked from `pause`
 * before each run; the first wait is picked from `firstPause` when given.
 * Returns what stops it.
 */
export function repeatAtRandom(pause: Span, act: () => void, firstPause: Span = pause): () => void {
	let timer: ReturnType<typeof setTimeout>;
	const waitThenAct = (wait: Span) => {
		timer = setTimeout(() => {
			act();
			waitThenAct(pause);
		}, randomIn(wait) * 1000);
	};
	waitThenAct(firstPause);
	return () => clearTimeout(timer);
}

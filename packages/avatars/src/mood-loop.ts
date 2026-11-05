import { useEffect, useRef, useState } from "react";
import { useLiveliness } from "./liveliness.ts";
import type { BotMood } from "./moods.ts";
import { randomIn, type Span } from "./random.ts";

/** One stretch of a mood in a loop: how likely it is to come next, and how long it lasts. */
interface MoodSpell {
	readonly mood: BotMood;
	readonly weight: number;
	readonly seconds: Span;
}

/**
 * The moods a bot moves between, at random, by weight. The first spell is the
 * one it rests in: it starts there, and when faces should move often it rests
 * there half as long. A spell never follows itself, so a short, lively mood
 * can't run on.
 */
export type MoodLoop = readonly [MoodSpell, ...MoodSpell[]];

/** How much shorter the resting spell is when faces should move often. */
export const OFTEN_REST_SHARE = 0.5;

/**
 * The mood a bot is in now, moving through `loop`. While `running` is false it
 * stays in the resting mood. A changed loop takes effect from the next spell,
 * so a loop written out on each render doesn't start over.
 */
export function useMoodLoop(loop: MoodLoop, running = true): BotMood {
	const liveliness = useLiveliness();
	const latestLoop = useRef(loop);
	latestLoop.current = loop;
	const [spell, setSpell] = useState<MoodSpell>(loop[0]);

	useEffect(() => {
		const [rest] = latestLoop.current;
		setSpell(rest);
		if (!running || liveliness === "off") return;
		let timer: ReturnType<typeof setTimeout>;
		const enter = (current: MoodSpell) => {
			setSpell(current);
			const share = current === rest && liveliness === "often" ? OFTEN_REST_SHARE : 1;
			const seconds = randomIn(current.seconds) * share;
			timer = setTimeout(() => enter(pickNext(latestLoop.current, current)), seconds * 1000);
		};
		enter(rest);
		return () => clearTimeout(timer);
	}, [running, liveliness]);

	return spell.mood;
}

/** A spell other than `current`, chosen at random by weight. */
function pickNext(loop: MoodLoop, current: MoodSpell): MoodSpell {
	const others = loop.filter((spell) => spell !== current);
	const total = others.reduce((sum, spell) => sum + spell.weight, 0);
	let roll = Math.random() * total;
	for (const spell of others) {
		roll -= spell.weight;
		if (roll <= 0) return spell;
	}
	return others.at(-1) ?? current;
}

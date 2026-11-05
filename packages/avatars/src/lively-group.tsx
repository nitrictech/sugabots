import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { pacingByLiveliness } from "./group-pacing.ts";
import { useLiveliness } from "./liveliness.ts";
import { randomIn, repeatAtRandom } from "./random.ts";

/*
 * Faces in a group, such as a list of bots, mostly sit still and take short
 * turns moving, so only a few move at once and the list doesn't fidget.
 */

/** The faces in a group, each told when its turn starts and ends. */
class Turns {
	private readonly members = new Set<(moving: boolean) => void>();
	private readonly moving = new Set<(moving: boolean) => void>();

	join(setMoving: (moving: boolean) => void): () => void {
		this.members.add(setMoving);
		return () => {
			this.members.delete(setMoving);
			this.moving.delete(setMoving);
		};
	}

	/** Gives a turn to a face not already moving, if fewer than `limit` are; returns what ends it. */
	startTurn(limit: number): (() => void) | undefined {
		if (this.moving.size >= limit) return;
		const waiting = [...this.members].filter((member) => !this.moving.has(member));
		const member = waiting[Math.floor(Math.random() * waiting.length)];
		if (!member) return;
		this.moving.add(member);
		member(true);
		return () => {
			this.moving.delete(member);
			member(false);
		};
	}
}

const TurnsContext = createContext<Turns | undefined>(undefined);

/** Paces the faces inside it so they take turns to move (see `useGroupTurn`). */
export function LivelyGroup({ children }: { children: ReactNode }) {
	const liveliness = useLiveliness();
	const [turns] = useState(() => new Turns());

	useEffect(() => {
		if (liveliness === "off") return;
		const { movingAtOnce, gapSeconds, turnSeconds } = pacingByLiveliness[liveliness];
		// What ends each turn under way early, should the group go.
		const endingEarly = new Set<() => void>();
		const stopStartingTurns = repeatAtRandom(gapSeconds, () => {
			const end = turns.startTurn(movingAtOnce);
			if (!end) return;
			const timer = setTimeout(() => {
				endingEarly.delete(endEarly);
				end();
			}, randomIn(turnSeconds) * 1000);
			const endEarly = () => {
				clearTimeout(timer);
				end();
			};
			endingEarly.add(endEarly);
		});
		return () => {
			stopStartingTurns();
			for (const endEarly of endingEarly) endEarly();
		};
	}, [liveliness, turns]);

	return <TurnsContext value={turns}>{children}</TurnsContext>;
}

/** Whether it's this face's turn to move, in the nearest `LivelyGroup`; never outside one. */
export function useGroupTurn(): boolean {
	const turns = useContext(TurnsContext);
	const [moving, setMoving] = useState(false);
	useEffect(() => turns?.join(setMoving), [turns]);
	return moving;
}

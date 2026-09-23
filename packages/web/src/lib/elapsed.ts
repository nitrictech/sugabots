import { useEffect, useState } from "react";

/**
 * Milliseconds since `startedAt`, ticking every second, or 0 when there is
 * nothing to count from. Used wherever the thread shows how long something
 * unfinished has been going — a tool still running, an approval still waiting
 * — where the elapsed time is the only timing there is.
 */
export function useElapsedSince(startedAt: string | undefined): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!startedAt) return;
		setNow(Date.now());
		const tick = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(tick);
	}, [startedAt]);
	if (!startedAt) return 0;
	return Math.max(now - new Date(startedAt).getTime(), 0);
}

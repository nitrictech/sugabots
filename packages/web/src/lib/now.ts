import { useEffect, useState } from "react";

/**
 * The time now, in epoch milliseconds, again every `intervalMs` while
 * `ticking`; while not, the time it stopped.
 */
export function useNow(intervalMs: number, ticking = true): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!ticking) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs, ticking]);
	return now;
}

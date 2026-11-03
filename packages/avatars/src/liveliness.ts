import { useReducedMotion } from "motion/react";
import { createContext, useContext } from "react";

/** How much bot faces move, as someone has chosen: not at all, now and then, or often. */
export type Liveliness = "off" | "sometimes" | "often";

export const livelinessLevels: readonly Liveliness[] = ["off", "sometimes", "often"];

/** What someone gets before they choose. */
export const defaultLiveliness: Liveliness = "often";

/**
 * How much the faces inside it move. With no provider they stay still, so a
 * page or test only gets movement it asks for.
 */
export const LivelinessContext = createContext<Liveliness>("off");

/** How much faces here may move: as chosen, or not at all when the system asks for reduced motion. */
export function useLiveliness(): Liveliness {
	const chosen = useContext(LivelinessContext);
	return useReducedMotion() ? "off" : chosen;
}

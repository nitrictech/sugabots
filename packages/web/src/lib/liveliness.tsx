import {
	defaultLiveliness,
	type Liveliness,
	LivelinessContext,
	livelinessLevels,
} from "@sugabots/avatars";
import type { ReactNode } from "react";
import { useLocalStorage } from "usehooks-ts";

/*
 * How much bots' faces move, as the viewer chose in settings. It's kept in
 * this browser, so each browser remembers its own choice; every use of it,
 * in any tab, sees a change at once.
 */

const KEY = "sugabots-liveliness";

const storage = {
	serializer: (liveliness: Liveliness) => liveliness,
	deserializer: (stored: string) =>
		livelinessLevels.find((level) => level === stored) ?? defaultLiveliness,
};

/** The viewer's chosen liveliness, and what changes it. */
export function useLivelinessChoice(): [Liveliness, (next: Liveliness) => void] {
	const [liveliness, setLiveliness] = useLocalStorage(KEY, defaultLiveliness, storage);
	return [liveliness, setLiveliness];
}

/** Gives every bot face inside it the viewer's chosen liveliness. */
export function LivelinessProvider({ children }: { children: ReactNode }) {
	const [liveliness] = useLivelinessChoice();
	return <LivelinessContext value={liveliness}>{children}</LivelinessContext>;
}

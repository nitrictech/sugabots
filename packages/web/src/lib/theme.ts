import { useCallback, useEffect, useState } from "react";

/**
 * Dark, light, or whatever the machine is set to.
 *
 * `dark` is the default and needs no attribute: the stylesheet declares both
 * arms of every colour with `light-dark()` and sets the root to dark. Picking
 * light or system stamps `data-theme` on the root element, which is the only
 * thing that overrides it — see the top of `app.css`, and the pre-paint script
 * in `index.html` that applies a remembered choice before React turns.
 */

export type Theme = "light" | "dark" | "system";

const KEY = "sugabots-theme";

export function useTheme(): [Theme, (next: Theme) => void] {
	const [theme, setThemeState] = useState<Theme>(read);

	// The script in index.html has usually done this already. Doing it again on
	// mount is what keeps the two honest if the stored value changes underneath.
	useEffect(() => {
		apply(theme);
	}, [theme]);

	const setTheme = useCallback((next: Theme) => {
		setThemeState(next);
		try {
			if (next === "dark") {
				localStorage.removeItem(KEY);
			} else {
				localStorage.setItem(KEY, next);
			}
		} catch {
			// Storage can be off. The theme still applies for this session.
		}
	}, []);

	return [theme, setTheme];
}

function read(): Theme {
	try {
		const stored = localStorage.getItem(KEY);
		return stored === "light" || stored === "system" ? stored : "dark";
	} catch {
		return "dark";
	}
}

function apply(theme: Theme): void {
	if (theme === "dark") {
		delete document.documentElement.dataset.theme;
	} else {
		document.documentElement.dataset.theme = theme;
	}
}

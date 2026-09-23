import { useCallback, useEffect, useState } from "react";

/**
 * Light, dark, or whatever the machine is set to.
 *
 * `system` is the default and is not a third palette: the stylesheet declares
 * both arms of every colour with `light-dark()`, so following the system is the
 * absence of a choice rather than a choice of its own. Picking light or dark
 * stamps `data-theme` on the root element, which is the only thing that
 * overrides it — see the top of `app.css`, and the pre-paint script in
 * `index.html` that applies a remembered choice before React turns.
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
			if (next === "system") {
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
		return stored === "light" || stored === "dark" ? stored : "system";
	} catch {
		return "system";
	}
}

function apply(theme: Theme): void {
	if (theme === "system") {
		delete document.documentElement.dataset.theme;
	} else {
		document.documentElement.dataset.theme = theme;
	}
}

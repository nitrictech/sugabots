import { type KeyboardEvent, useEffect, useRef } from "react";

/**
 * What makes a panel beside a chat, such as Details or a bot's computer,
 * answer Escape: spread onto the panel's root element. The panel takes the
 * focus as it opens, unless the viewer is typing somewhere, so Escape reaches
 * it without a click first. Escape calls `onEscape` once, from the innermost
 * panel holding the focus, so a panel inside another goes back one level.
 */
export function usePanelKeys<Root extends HTMLElement>(onEscape: () => void) {
	const ref = useRef<Root>(null);
	useEffect(() => {
		const panel = ref.current;
		const focused = document.activeElement;
		if (!panel || panel.contains(focused) || isTypingIn(focused)) return;
		panel.focus({ preventScroll: true });
	}, []);
	return {
		ref,
		tabIndex: -1,
		onKeyDown: (event: KeyboardEvent) => {
			// Already answered, by a field undoing an edit or by a panel inside this one.
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			onEscape();
		},
	};
}

function isTypingIn(element: Element | null): boolean {
	return (
		element instanceof HTMLElement &&
		(element.isContentEditable || element.matches("input, textarea, select"))
	);
}

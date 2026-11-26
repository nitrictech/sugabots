import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** The space between the text and a menu floating just above it. */
export const MENU_GAP_PX = 6;

/** The least room a floating menu keeps from the window's edges. */
const MENU_MARGIN_PX = 16;

/**
 * FloatingMenu is a toolbar floating just above the editor's text, as the
 * menu for selected text and the menu for a link are. It sits in the window,
 * not the page, as the page clips what reaches past its edges, such as a menu
 * over its first line. Its bottom left corner goes `at`, moved across where
 * the menu would run past the window's margins, and moved again whenever its
 * contents or the window change width. It is as wide as its contents, except
 * in a window too narrow for them, where it fills the room between the
 * margins and its controls wrap onto more rows, growing upwards. A press on it
 * keeps the text's caret and selection, except in a field, where it places the
 * field's caret.
 */
export function FloatingMenu({
	at,
	label,
	children,
}: {
	/** Where in the window the menu's bottom left corner goes. */
	at: { top: number; left: number };
	/** What the toolbar is for, as assistive technology names it. */
	label: string;
	children: ReactNode;
}) {
	return createPortal(
		<div
			role="toolbar"
			aria-label={label}
			style={{
				top: at.top,
				left: at.left,
				maxWidth: `calc(100vw - ${2 * MENU_MARGIN_PX}px)`,
				translate: `${shiftIntoWindow(at.left)} -100%`,
			}}
			onMouseDown={(event) => {
				if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
			}}
			className="fixed z-40 flex w-max flex-wrap items-center gap-0.5 rounded-lg border border-border-strong bg-panel p-1 shadow-popover"
		>
			{children}
		</div>,
		document.body,
	);
}

export const MenuDivider = () => <span aria-hidden className="mx-0.5 h-4 w-px bg-border-strong" />;

/**
 * How far across a menu whose left edge is `left` in the window moves to sit
 * inside the window's margins: left by as much as it would run past the right
 * margin, but never so far that it starts before the left margin. CSS works it
 * out, as `100%` in a translation is the menu's own width, so the menu stays
 * inside whenever its contents or the window change width, without measuring.
 */
function shiftIntoWindow(left: number): string {
	const roomBeforeRightMargin = `100vw - 100% - ${MENU_MARGIN_PX + left}px`;
	return `max(${MENU_MARGIN_PX - left}px, min(0px, ${roomBeforeRightMargin}))`;
}

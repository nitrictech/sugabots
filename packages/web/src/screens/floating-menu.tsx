import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** The space between the text and a menu floating just above it. */
export const MENU_GAP_PX = 6;

/** The least room a floating menu keeps from the window's edge. */
const MENU_MARGIN_PX = 16;

/**
 * FloatingMenu is a toolbar floating just above the editor's text, as the
 * menu for selected text and the menu for a link are. It sits in the window,
 * not the page, as the page clips what reaches past its edges, such as a menu
 * over its first line. Its bottom left corner goes `at`, moved left where it
 * would run off the window. A press on it keeps the text's caret and
 * selection, except in a field, where it places the field's caret.
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
	const menu = useRef<HTMLDivElement>(null);
	const [left, setLeft] = useState(at.left);
	useLayoutEffect(() => {
		const roomAcross = window.innerWidth - (menu.current?.offsetWidth ?? 0) - MENU_MARGIN_PX;
		setLeft(Math.max(MENU_MARGIN_PX, Math.min(at.left, roomAcross)));
	}, [at.left]);
	return createPortal(
		<div
			ref={menu}
			role="toolbar"
			aria-label={label}
			style={{ top: at.top, left }}
			onMouseDown={(event) => {
				if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
			}}
			className="fixed z-40 flex -translate-y-full items-center gap-0.5 rounded-lg border border-border-strong bg-panel p-1 shadow-popover"
		>
			{children}
		</div>,
		document.body,
	);
}

export const MenuDivider = () => <span aria-hidden className="mx-0.5 h-4 w-px bg-border-strong" />;

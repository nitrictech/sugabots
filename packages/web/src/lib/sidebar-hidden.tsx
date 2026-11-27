import { createContext, use, useEffect, useState } from "react";

const STORAGE_KEY = "sugabots-sidebar-hidden";

/**
 * Whether the viewer put the sidebar away. Only a chat or a page with a
 * title bar hides it, as only those have room for the button that brings it
 * back, so any other page, such as Settings, shows it again.
 */
export interface SidebarHiding {
	/** Put away by the viewer, whether or not a chat is open to hide it. */
	hidden: boolean;
	toggle: () => void;
	/** Puts it away, as double-clicking a chat in it does. */
	hide: () => void;
	/** Whether a chat's or a page's header is on screen, so the button and the hiding apply. */
	chatShowing: boolean;
	/** Says a chat's header is on screen, for as long as it is; returns the way to say it is gone. */
	showingChat: () => () => void;
}

const SidebarHidingContext = createContext<SidebarHiding | undefined>(undefined);

export const SidebarHidingProvider = SidebarHidingContext.Provider;

/** The shell's record of whether the sidebar is put away, remembered on this device. */
export function useSidebarHidingState(): SidebarHiding {
	const [hidden, setHidden] = useState(storedHidden);
	const [chatsShowing, setChatsShowing] = useState(0);
	const choose = (next: boolean) => {
		setHidden(next);
		try {
			localStorage.setItem(STORAGE_KEY, String(next));
		} catch {
			// Storage can be off. The sidebar still stays as chosen until the page is left.
		}
	};
	return {
		hidden,
		toggle: () => choose(!hidden),
		hide: () => choose(true),
		chatShowing: chatsShowing > 0,
		showingChat: () => {
			setChatsShowing((count) => count + 1);
			return () => setChatsShowing((count) => count - 1);
		},
	};
}

/**
 * For a chat's or a page's header, which makes way for the button while the
 * sidebar is hidden: whether it is. False outside the shell, as in a story.
 */
export function useSidebarHiddenBesideChat(): boolean {
	const hiding = use(SidebarHidingContext);
	// Once for as long as the header is up: `showingChat` only counts, so the first one stands for every later one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above.
	useEffect(() => hiding?.showingChat(), []);
	return hiding?.hidden ?? false;
}

/**
 * Puts the sidebar away, for a chat in it double-clicked: the first click
 * opens the chat, the second leaves it the room. Nothing outside the shell.
 */
export function useHideSidebar(): () => void {
	const hiding = use(SidebarHidingContext);
	return () => hiding?.hide();
}

function storedHidden(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

/// <reference types="vite/client" />

/** Build-time configuration. Vite inlines these; nothing secret goes here. */
interface ImportMetaEnv {
	/** Where the API is, path included. Unset, `/api` of the page's own origin. */
	readonly VITE_API_URL?: string;
}

/** The parts of noVNC's client the desktop viewer uses; noVNC ships no types. */
declare module "@novnc/novnc" {
	export default class RFB extends EventTarget {
		constructor(target: HTMLElement, url: string);
		viewOnly: boolean;
		scaleViewport: boolean;
		background: string;
		/** Sends a key to the display: down, up, or, with `down` left out, both. */
		sendKey(keysym: number, code: string, down?: boolean): void;
		/** Puts text on the display's clipboard. */
		clipboardPasteFrom(text: string): void;
		disconnect(): void;
	}
}

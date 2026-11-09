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
		/** The JPEG quality, 0 to 9, it asks the server to encode with. */
		qualityLevel: number;
		background: string;
		/** Whether a click or tap on the screen moves focus to it. */
		focusOnClick: boolean;
		disconnect(): void;
		/** Puts text on the remote desktop's clipboard. */
		clipboardPasteFrom(text: string): void;
		/** Presses (`down`) or releases an X11 keysym on the remote desktop. */
		sendKey(keysym: number, code: string, down?: boolean): void;
	}
}

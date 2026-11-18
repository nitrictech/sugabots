import { join } from "node:path";
import type { WebContents } from "electron";

/** The app's own pages, each built from `src/<page>/` with its own preload. */
export type LocalPage = "setup" | "switcher" | "unreachable";

export function localPreload(page: LocalPage): string {
	return join(import.meta.dirname, `../preload/${page}-preload.cjs`);
}

export function loadLocalPage(
	webContents: WebContents,
	page: LocalPage,
	query: Record<string, string> = {},
): Promise<void> {
	// electron-vite's dev server, which reloads a page when its source changes.
	const devServer = process.env.ELECTRON_RENDERER_URL;
	if (devServer) {
		return webContents.loadURL(`${devServer}/${page}/page.html?${new URLSearchParams(query)}`);
	}
	return webContents.loadFile(join(import.meta.dirname, `../renderer/${page}/page.html`), {
		query,
	});
}

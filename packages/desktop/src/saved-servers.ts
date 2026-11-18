import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { app } from "electron";

/** The servers the person has added, in the order they added them. */
export interface SavedServers {
	readonly origins: readonly string[];
	/** The one the app opens: one of `origins`, unless there are none. */
	readonly current: string | undefined;
}

const SettingsFile = Schema.Struct({
	servers: Schema.Array(Schema.String),
	current: Schema.optional(Schema.String),
});
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(SettingsFile));

/** The saved servers, or none when the person hasn't added one or the file is unreadable. */
export async function loadSavedServers(): Promise<SavedServers> {
	const text = await readFile(settingsPath(), "utf8").catch(() => undefined);
	const settings = Option.getOrUndefined(decodeSettings(text));
	const origins = settings?.servers ?? [];
	// The file is the person's to edit, so it might name a server that isn't in the list.
	const current = origins.find((origin) => origin === settings?.current) ?? origins[0];
	return { origins, current };
}

export async function saveSavedServers(saved: SavedServers): Promise<void> {
	await writeFile(
		settingsPath(),
		JSON.stringify({ servers: saved.origins, current: saved.current }),
	);
}

/** Makes `origin` the server the app opens, adding it if it's new. */
export function withServerOpened(saved: SavedServers, origin: string): SavedServers {
	const origins = saved.origins.includes(origin) ? saved.origins : [...saved.origins, origin];
	return { origins, current: origin };
}

/** Removes `origin`; when it was the one the app opens, the app opens the first remaining one instead. */
export function withServerRemoved(saved: SavedServers, origin: string): SavedServers {
	const origins = saved.origins.filter((savedOrigin) => savedOrigin !== origin);
	return { origins, current: saved.current === origin ? origins[0] : saved.current };
}

/** How menus and titles name a server: its host, with the port when it has one. */
export function serverLabel(origin: string): string {
	return new URL(origin).host;
}

function settingsPath(): string {
	return join(app.getPath("userData"), "settings.json");
}

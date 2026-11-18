import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { app } from "electron";

/** Names a saved server's session. Saving a server twice gives two sessions, to stay signed in to two accounts on it. */
export const ServerId = Schema.String.pipe(Schema.brand("ServerId"));
export type ServerId = typeof ServerId.Type;

const SavedServer = Schema.Struct({
	id: ServerId,
	origin: Schema.String,
	/** The email it was last signed in as, which tells two saves of one server apart. */
	account: Schema.optional(Schema.String),
});
export type SavedServer = typeof SavedServer.Type;

const SavedServers = Schema.Struct({
	/** In the order the person added them. */
	servers: Schema.Array(SavedServer),
	/** The one the app opens. */
	current: Schema.optional(ServerId),
});
export type SavedServers = typeof SavedServers.Type;

const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(SavedServers));

/** The saved servers, or none when the person hasn't added one or the file is unreadable. */
export async function loadSavedServers(): Promise<SavedServers> {
	const text = await readFile(settingsPath(), "utf8").catch(() => undefined);
	const saved = Option.getOrElse(decodeSettings(text), (): SavedServers => ({ servers: [] }));
	// The file is the person's to edit, so `current` might name a server that isn't saved.
	return withServerOpened(saved, saved.current);
}

export async function saveSavedServers(saved: SavedServers): Promise<void> {
	await writeFile(settingsPath(), JSON.stringify(saved));
}

export function serverById(saved: SavedServers, id: ServerId | undefined): SavedServer | undefined {
	return saved.servers.find((server) => server.id === id);
}

/** Saves `origin` again with a session of its own, and makes it the one the app opens. */
export function withServerAdded(saved: SavedServers, origin: string): SavedServers {
	const server = { id: ServerId.make(randomUUID()), origin };
	return { servers: [...saved.servers, server], current: server.id };
}

/** Makes `id` the server the app opens; with none, the first saved one. */
export function withServerOpened(saved: SavedServers, id: ServerId | undefined): SavedServers {
	return { ...saved, current: serverById(saved, id)?.id ?? saved.servers[0]?.id };
}

/** Removes `id`; when the app opened it, the app opens the first remaining server instead. */
export function withServerRemoved(saved: SavedServers, id: ServerId): SavedServers {
	const servers = saved.servers.filter((server) => server.id !== id);
	return withServerOpened({ servers }, saved.current === id ? undefined : saved.current);
}

/** Records who `id` is signed in as, returning `saved` itself when that hasn't changed. */
export function withAccount(
	saved: SavedServers,
	id: ServerId,
	account: string | undefined,
): SavedServers {
	const server = serverById(saved, id);
	if (!server || server.account === account) return saved;
	const servers = saved.servers.map((other) => (other === server ? { ...server, account } : other));
	return { ...saved, servers };
}

/** How menus and titles name a saved server: who it's signed in as and its host. */
export function serverLabel(saved: SavedServers, server: SavedServer): string {
	const host = serverHost(server.origin);
	if (server.account) return `${server.account} on ${host}`;
	const savedTwice = saved.servers.some(
		(other) => other !== server && other.origin === server.origin,
	);
	return savedTwice ? `${host} (not signed in)` : host;
}

/** A server's host, with the port when it has one. */
export function serverHost(origin: string): string {
	return new URL(origin).host;
}

function settingsPath(): string {
	return join(app.getPath("userData"), "settings.json");
}

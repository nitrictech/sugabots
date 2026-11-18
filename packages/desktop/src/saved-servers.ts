import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { app } from "electron";

/** Names a saved server's session. Saving a server twice gives two sessions, to stay signed in to two accounts on it. */
export const ServerId = Schema.String.pipe(Schema.brand("ServerId"));
export type ServerId = typeof ServerId.Type;

export const SavedWorkspace = Schema.Struct({
	/** The first segment of the workspace's address on its server. */
	slug: Schema.String,
	name: Schema.String,
});
export type SavedWorkspace = typeof SavedWorkspace.Type;

const SavedServer = Schema.Struct({
	id: ServerId,
	origin: Schema.String,
	/** The email it was last signed in as, which tells two saves of one server apart. */
	account: Schema.optional(Schema.String),
	/** The workspaces that account was last in, so menus list them before the server is asked again. */
	workspaces: Schema.optional(Schema.Array(SavedWorkspace)),
	/** The slug of the workspace last open in it, which opening it again returns to. */
	lastWorkspace: Schema.optional(Schema.String),
});
export type SavedServer = typeof SavedServer.Type;

const SavedServers = Schema.Struct({
	/** In the order the person added them. */
	servers: Schema.Array(SavedServer),
	/** The one the app opens. */
	current: Schema.optional(ServerId),
});
export type SavedServers = typeof SavedServers.Type;

/** Who a saved server's session is signed in as, and the workspaces they're in there. */
export interface SignIn {
	readonly account: string;
	readonly workspaces: readonly SavedWorkspace[];
}

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

/** Makes `id` the server the app opens, at its workspace `slug`. */
export function withWorkspaceOpened(saved: SavedServers, id: ServerId, slug: string): SavedServers {
	return withServerOpened(withServer(saved, id, { lastWorkspace: slug }), id);
}

/** Removes `id`; when the app opened it, the app opens the first remaining server instead. */
export function withServerRemoved(saved: SavedServers, id: ServerId): SavedServers {
	const servers = saved.servers.filter((server) => server.id !== id);
	return withServerOpened({ servers }, saved.current === id ? undefined : saved.current);
}

/**
 * Records who `id` is signed in as and their workspaces, with `undefined`
 * once it's signed out. Returns `saved` itself when that hasn't changed.
 */
export function withSignIn(
	saved: SavedServers,
	id: ServerId,
	signIn: SignIn | undefined,
): SavedServers {
	const server = serverById(saved, id);
	if (!server) return saved;
	const workspaces = signIn?.workspaces ?? [];
	const unchanged =
		server.account === signIn?.account &&
		JSON.stringify(server.workspaces ?? []) === JSON.stringify(workspaces);
	return unchanged ? saved : withServer(saved, id, { account: signIn?.account, workspaces });
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

/** The page opening `server` shows: the workspace last open in it while it's still in that one, or else its home page, which picks one. */
export function serverUrl(server: SavedServer): string {
	const last = server.workspaces?.find((workspace) => workspace.slug === server.lastWorkspace);
	return last ? workspaceUrl(server, last) : server.origin;
}

export function workspaceUrl(server: SavedServer, workspace: SavedWorkspace): string {
	return new URL(`/${encodeURIComponent(workspace.slug)}`, server.origin).href;
}

/** The workspace of `server` that `url` is a page of, if any. */
export function workspaceAt(server: SavedServer, url: string): SavedWorkspace | undefined {
	const page = URL.parse(url);
	if (page?.origin !== new URL(server.origin).origin) return undefined;
	const [first] = page.pathname.split("/").filter(Boolean);
	return server.workspaces?.find((workspace) => encodeURIComponent(workspace.slug) === first);
}

function withServer(
	saved: SavedServers,
	id: ServerId,
	changes: Partial<Omit<SavedServer, "id" | "origin">>,
): SavedServers {
	const servers = saved.servers.map((server) =>
		server.id === id ? { ...server, ...changes } : server,
	);
	return { ...saved, servers };
}

function settingsPath(): string {
	return join(app.getPath("userData"), "settings.json");
}

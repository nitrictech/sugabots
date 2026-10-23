import { join } from "node:path";
import { Schema } from "effect";
import { Utils } from "electrobun/main";
import { type LentAgent, lentAgentSchema } from "./local-agents.ts";

/** Under the build's own data folder, so a dev build never shares an installed copy's. */
const SETTINGS_PATH = join(Utils.paths.userData, "settings.json");

const settingsSchema = Schema.Struct({
	server: Schema.optional(Schema.String),
	/** This computer's device token, for the server it was paired with. Never logged. */
	device: Schema.optional(Schema.Struct({ server: Schema.String, token: Schema.String })),
	/** The local agents this computer lends to the server it's paired with. */
	agents: Schema.optional(Schema.Array(lentAgentSchema)),
	/** Each lent agent's Claude Code session for each conversation, by agent id then A2A context id. */
	sessions: Schema.optional(
		Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
	),
});

type Settings = typeof settingsSchema.Type;

const decodeSettings = Schema.decodeUnknownOption(settingsSchema);

async function loadSettings(): Promise<Settings> {
	const file = Bun.file(SETTINGS_PATH);
	if (!(await file.exists())) return {};
	const settings = decodeSettings(await file.json().catch(() => undefined));
	return settings._tag === "Some" ? settings.value : {};
}

async function updateSettings(change: (settings: Settings) => Settings): Promise<void> {
	await Bun.write(SETTINGS_PATH, JSON.stringify(change(await loadSettings())));
}

/** The origin of the server the person chose, unless they haven't or the file is unreadable. */
export async function loadServer(): Promise<string | undefined> {
	return (await loadSettings()).server;
}

/** Saves the server, forgetting the device token when it was for another one. */
export async function saveServer(origin: string): Promise<void> {
	await updateSettings((settings) => ({
		...settings,
		server: origin,
		device: settings.device?.server === origin ? settings.device : undefined,
	}));
}

/** This computer's device token for `server`, if it has been paired with it. */
export async function loadDeviceToken(server: string): Promise<string | undefined> {
	const { device } = await loadSettings();
	return device?.server === server ? device.token : undefined;
}

/** Keeps `token` as this computer's device token for `server`, or forgets it. */
export async function saveDeviceToken(
	device: { server: string; token: string } | undefined,
): Promise<void> {
	await updateSettings((settings) => ({ ...settings, device }));
}

export async function loadAgents(): Promise<ReadonlyArray<LentAgent>> {
	return (await loadSettings()).agents ?? [];
}

export async function saveAgents(agents: ReadonlyArray<LentAgent>): Promise<void> {
	await updateSettings((settings) => ({ ...settings, agents }));
}

export async function loadSessions(): Promise<Record<string, Record<string, string>>> {
	return structuredClone((await loadSettings()).sessions ?? {});
}

export async function saveSessions(
	sessions: Record<string, Record<string, string>>,
): Promise<void> {
	await updateSettings((settings) => ({ ...settings, sessions }));
}

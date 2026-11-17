import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { app } from "electron";

const Settings = Schema.Struct({ server: Schema.String });
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(Settings));

/** The origin of the server the person chose, unless they haven't or the file is unreadable. */
export async function loadServer(): Promise<string | undefined> {
	const text = await readFile(settingsPath(), "utf8").catch(() => undefined);
	return decodeSettings(text).pipe(
		Option.map((settings) => settings.server),
		Option.getOrUndefined,
	);
}

export async function saveServer(origin: string): Promise<void> {
	await writeFile(settingsPath(), JSON.stringify({ server: origin }));
}

function settingsPath(): string {
	return join(app.getPath("userData"), "settings.json");
}

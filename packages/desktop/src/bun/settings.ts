import { join } from "node:path";
import { Schema } from "effect";
import { Utils } from "electrobun/main";

/** Under the build's own data folder, so a dev build never shares an installed copy's. */
const SETTINGS_PATH = join(Utils.paths.userData, "settings.json");

const Settings = Schema.Struct({ server: Schema.String });
const decodeSettings = Schema.decodeUnknownOption(Settings);

/** The origin of the server the person chose, unless they haven't or the file is unreadable. */
export async function loadServer(): Promise<string | undefined> {
	const file = Bun.file(SETTINGS_PATH);
	if (!(await file.exists())) return undefined;
	const settings = decodeSettings(await file.json().catch(() => undefined));
	return settings._tag === "Some" ? settings.value.server : undefined;
}

export async function saveServer(origin: string): Promise<void> {
	await Bun.write(SETTINGS_PATH, JSON.stringify({ server: origin }));
}

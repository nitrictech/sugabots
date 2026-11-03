/**
 * Regenerates every file the app copies from the web's packages and the API:
 *
 *     node apps/ios/scripts/generate.ts
 *
 * Run it after any of their sources change. The `ios` tests fail until it has
 * been, and the app then fails to build wherever it relied on what changed.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as api from "./generate-api.ts";
import * as botLooks from "./generate-bot-looks.ts";
import * as builtInTools from "./generate-built-in-tools.ts";
import * as connectionMarks from "./generate-connection-marks.ts";
import * as emoji from "./generate-emoji.ts";
import * as lucideIcons from "./generate-lucide-icons.ts";
import * as palette from "./generate-palette.ts";
import * as providerLogos from "./generate-provider-logos.ts";
import type { GeneratedFiles } from "./generated-files.ts";

/** Every generator, by the script that holds it. */
export const generators: Record<string, () => GeneratedFiles> = {
	"generate-api.ts": api.generate,
	"generate-bot-looks.ts": botLooks.generate,
	"generate-built-in-tools.ts": builtInTools.generate,
	"generate-connection-marks.ts": connectionMarks.generate,
	"generate-emoji.ts": emoji.generate,
	"generate-lucide-icons.ts": lucideIcons.generate,
	"generate-palette.ts": palette.generate,
	"generate-provider-logos.ts": providerLogos.generate,
};

/** `apps/ios`, which generated paths are relative to. */
export const appRoot = fileURLToPath(new URL("../", import.meta.url));

if (import.meta.main) {
	for (const [script, generate] of Object.entries(generators)) {
		const { files, folder } = generate();
		if (folder) rmSync(appRoot + folder, { recursive: true, force: true });
		for (const [path, contents] of files) {
			mkdirSync(dirname(appRoot + path), { recursive: true });
			writeFileSync(appRoot + path, contents);
		}
		console.log(`${script}: ${files.size} ${files.size === 1 ? "file" : "files"}`);
	}
}

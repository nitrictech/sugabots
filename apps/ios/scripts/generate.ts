/**
 * Regenerates every file the apps copy from the web's packages and the API:
 *
 *     node apps/ios/scripts/generate.ts
 *
 * Run it after any of their sources change. The `ios` tests fail until it has
 * been, and the apps then fail to build wherever they relied on what changed.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as api from "./generate-api.ts";
import * as artifactPages from "./generate-artifact-pages.ts";
import * as botLooks from "./generate-bot-looks.ts";
import * as builtInTools from "./generate-built-in-tools.ts";
import * as catalogs from "./generate-catalogs.ts";
import * as connectionMarks from "./generate-connection-marks.ts";
import * as emoji from "./generate-emoji.ts";
import * as limits from "./generate-limits.ts";
import * as lucideIcons from "./generate-lucide-icons.ts";
import * as nativeConstants from "./generate-native-constants.ts";
import * as palette from "./generate-palette.ts";
import * as providerLogos from "./generate-provider-logos.ts";
import { iosOnly, type RegisteredGenerator, register, targetRoots } from "./generated-files.ts";

/** Every generator, by the script that holds it. */
export const generators: Record<string, RegisteredGenerator> = {
	"generate-api.ts": register(api.generator),
	"generate-artifact-pages.ts": iosOnly(artifactPages.generate),
	"generate-bot-looks.ts": iosOnly(botLooks.generate),
	"generate-built-in-tools.ts": iosOnly(builtInTools.generate),
	"generate-catalogs.ts": iosOnly(catalogs.generate),
	"generate-connection-marks.ts": iosOnly(connectionMarks.generate),
	"generate-emoji.ts": iosOnly(emoji.generate),
	"generate-limits.ts": iosOnly(limits.generate),
	"generate-lucide-icons.ts": iosOnly(lucideIcons.generate),
	"generate-native-constants.ts": iosOnly(nativeConstants.generate),
	"generate-palette.ts": iosOnly(palette.generate),
	"generate-provider-logos.ts": iosOnly(providerLogos.generate),
};

if (import.meta.main) {
	for (const [script, generator] of Object.entries(generators)) {
		for (const target of generator.targets) {
			const root = targetRoots[target];
			const { files, folder } = generator.generate(target);
			if (folder) rmSync(root + folder, { recursive: true, force: true });
			for (const [path, contents] of files) {
				mkdirSync(dirname(root + path), { recursive: true });
				writeFileSync(root + path, contents);
			}
			console.log(`${script} (${target}): ${files.size} ${files.size === 1 ? "file" : "files"}`);
		}
	}
}

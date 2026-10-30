/**
 * Writes src/emoji.json, the app's emoji, from the installed `emojibase-data`.
 *
 * Run with `bun run --cwd packages/emoji generate` after upgrading
 * `emojibase-data`. The package's test fails until it is run.
 */
import { writeFileSync } from "node:fs";
import { buildEmojiDataset } from "../src/dataset.ts";
import { readEmojibase } from "../src/emojibase.ts";

const { emojibase, messages, shortcodes } = readEmojibase();
const dataset = buildEmojiDataset(emojibase, messages, shortcodes);
writeFileSync(new URL("../src/emoji.json", import.meta.url), `${JSON.stringify(dataset)}\n`);
console.log(`src/emoji.json: ${dataset.emojis.length} emoji`);

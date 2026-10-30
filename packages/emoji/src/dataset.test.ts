import { describe, expect, it } from "vitest";
import { buildEmojiDataset } from "./dataset.ts";
import generated from "./emoji.json" with { type: "json" };
import { readEmojibase } from "./emojibase.ts";
import { emojiNamed, findByShortcode } from "./shortcodes.ts";

const { emojibase, messages, shortcodes } = readEmojibase();
const dataset = buildEmojiDataset(emojibase, messages, shortcodes);

describe("emoji dataset", () => {
	it("is generated from the installed Emojibase (run `bun run --cwd packages/emoji generate`)", () => {
		expect(generated).toEqual(dataset);
	});

	it("finds an emoji by the shortcode people type", () => {
		expect(emojiNamed(dataset.emojis, "thinking")?.emoji).toBe("🤔");
		expect(emojiNamed(dataset.emojis, "+1")?.emoji).toBe("👍️");
		expect(findByShortcode(dataset.emojis, "thin")[0]?.emoji).toBe("🤔");
	});
});

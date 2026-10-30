import emojibase from "emojibase-data/en/data.json" with { type: "json" };
import messages from "emojibase-data/en/messages.json" with { type: "json" };
import shortcodes from "emojibase-data/en/shortcodes/github.json" with { type: "json" };
import type { EmojibaseEmoji, EmojibaseMessages, EmojibaseShortcodes } from "./dataset.ts";

/**
 * The installed Emojibase's English emoji, their names, and the shortcodes
 * GitHub uses, which Slack's match. Read when generating the dataset and when
 * testing it, never by the app.
 */
export function readEmojibase(): {
	emojibase: readonly EmojibaseEmoji[];
	messages: EmojibaseMessages;
	shortcodes: EmojibaseShortcodes;
} {
	return { emojibase, messages, shortcodes };
}

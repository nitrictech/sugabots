/**
 * Where the app serves the Emojibase data its emoji picker and the composer's
 * shortcodes read, copied there from `emojibase-data` when it is built, and
 * the one locale it serves.
 */
export const EMOJI_DATA_PATH = "/emojibase-data";
export const EMOJI_LOCALE = "en";
/** The shortcodes typed between colons, within the locale's folder: GitHub's, which Slack's match. */
export const EMOJI_SHORTCODES = "shortcodes/github.json";

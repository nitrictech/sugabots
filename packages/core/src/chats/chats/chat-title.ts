import { MAX_CHAT_TITLE_CHARACTERS, withoutMentions } from "@sugabots/contracts";

/**
 * The longest a chat's title is when it is made from a message, before
 * the ellipsis: as long as a title may be, so a sentence is cut only when it must.
 */
const CHAT_TITLE_MAX_CHARACTERS = MAX_CHAT_TITLE_CHARACTERS - 1;

/** What a chat is called when what it was started with has no words of its own. */
export const UNTITLED_CHAT = "New chat";

/**
 * The title for a chat started with `content`: its first sentence, with the
 * mentions taken out, cut to `CHAT_TITLE_MAX_CHARACTERS` characters with an
 * ellipsis, and capitalised.
 */
export function chatTitleFrom(content: string): string {
	const words = withoutMentions(content).replace(/\s+/g, " ").trim();
	const [sentence = ""] = words.split(/(?<=[.!?])\s/);
	const plain = sentence.replace(/^[\s,;:-]+/, "").trim();
	if (plain === "") return UNTITLED_CHAT;
	const characters = Array.from(plain[0]?.toUpperCase() + plain.slice(1));
	return characters.length > CHAT_TITLE_MAX_CHARACTERS
		? `${characters.slice(0, CHAT_TITLE_MAX_CHARACTERS).join("").trimEnd()}…`
		: characters.join("");
}

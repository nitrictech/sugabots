import { MAX_CONVERSATION_TITLE_CHARACTERS, withoutMentions } from "@sugabots/contracts";

/**
 * The longest a conversation's title is when it is made from a message, before
 * the ellipsis: as long as a title may be, so a sentence is cut only when it must.
 */
const THREAD_TITLE_MAX_CHARACTERS = MAX_CONVERSATION_TITLE_CHARACTERS - 1;

/** What a conversation is called when what it was started with has no words of its own. */
export const UNTITLED_THREAD = "New conversation";

/**
 * The title for a conversation started with `content`: its first sentence, with the
 * mentions taken out, cut to `THREAD_TITLE_MAX_CHARACTERS` characters with an
 * ellipsis, and capitalised.
 */
export function threadTitleFrom(content: string): string {
	const words = withoutMentions(content).replace(/\s+/g, " ").trim();
	const [sentence = ""] = words.split(/(?<=[.!?])\s/);
	const plain = sentence.replace(/^[\s,;:-]+/, "").trim();
	if (plain === "") return UNTITLED_THREAD;
	const characters = Array.from(plain[0]?.toUpperCase() + plain.slice(1));
	return characters.length > THREAD_TITLE_MAX_CHARACTERS
		? `${characters.slice(0, THREAD_TITLE_MAX_CHARACTERS).join("").trimEnd()}…`
		: characters.join("");
}

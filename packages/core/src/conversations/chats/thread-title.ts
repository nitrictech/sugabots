import { withoutMentions } from "@sugabots/contracts";

/** The longest a thread's title is when it is made from a message, before the ellipsis. */
const THREAD_TITLE_MAX_CHARACTERS = 44;

/** What a thread is called when what it was started with has no words of its own. */
export const UNTITLED_THREAD = "New thread";

/**
 * The title for a thread started with `content`: its first sentence, with the
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

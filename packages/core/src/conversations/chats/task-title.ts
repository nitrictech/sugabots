import { withoutMentions } from "@sugabots/contracts";

/** The longest a conversation's title is when it is made from a message, before the ellipsis. */
const TASK_TITLE_MAX_CHARACTERS = 44;

/** What a conversation is called when what it was started with has no words of its own. */
export const UNTITLED_TASK = "New conversation";

/**
 * The title for a conversation started with `content`: its first sentence, with the
 * mentions taken out, cut to `TASK_TITLE_MAX_CHARACTERS` characters with an
 * ellipsis, and capitalised.
 */
export function taskTitleFrom(content: string): string {
	const words = withoutMentions(content).replace(/\s+/g, " ").trim();
	const [sentence = ""] = words.split(/(?<=[.!?])\s/);
	const plain = sentence.replace(/^[\s,;:-]+/, "").trim();
	if (plain === "") return UNTITLED_TASK;
	const characters = Array.from(plain[0]?.toUpperCase() + plain.slice(1));
	return characters.length > TASK_TITLE_MAX_CHARACTERS
		? `${characters.slice(0, TASK_TITLE_MAX_CHARACTERS).join("").trimEnd()}…`
		: characters.join("");
}

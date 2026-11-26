import type { EditorView } from "@tiptap/pm/view";

/*
 * Cutting, copying and pasting in an editor from a menu, as its keyboard
 * shortcuts do: in the editor's own clipboard form, which keeps formatting and
 * structure through a round trip, and through the editor's own handling, so a
 * cut or a paste made while suggesting is a suggestion. A page can have the
 * browser cut or copy for it, but not paste, so a paste reads the clipboard
 * itself, which the browser may first ask the person to allow, or refuse.
 */

/**
 * Cuts or copies the editor's selection as the keyboard's shortcut does: the
 * editor takes the focus, as the browser's command acts where the focus is,
 * and the editor's own handling of the browser's cut or copy writes the
 * clipboard. Answers whether the browser carried the command out, which it
 * does only in answer to the person's click or key.
 */
export function cutOrCopy(view: EditorView, command: "cut" | "copy"): boolean {
	view.focus();
	return document.execCommand(command);
}

/** What the clipboard holds to paste: its formatted form, as HTML, and its text, each empty when it holds none. */
export interface ClipboardContent {
	html: string;
	text: string;
}

/**
 * Reads the clipboard, with its formatting or as text alone. Rejects where the
 * browser can't read it from a page, or when the person, asked to allow it,
 * doesn't.
 */
export async function readClipboard(withFormatting: boolean): Promise<ClipboardContent> {
	if (!withFormatting) return { html: "", text: await navigator.clipboard.readText() };
	// As copied, the HTML is what a paste from the keyboard gets. Chrome otherwise hands over a copy
	// it has rewritten with styles of its own, which the editor would read as formatting. The editor
	// only ever parses it into its own content, as it does a keyboard paste's.
	const items = await navigator.clipboard.read({ unsanitized: [HTML] });
	return { html: await contentOf(items, HTML), text: await contentOf(items, TEXT) };
}

const HTML = "text/html";
const TEXT = "text/plain";

/** What the first of `items` holding `type` holds of it, or nothing when none does. */
async function contentOf(items: ClipboardItems, type: string): Promise<string> {
	const item = items.find((each) => each.types.includes(type));
	return item ? (await item.getType(type)).text() : "";
}

/**
 * Pastes `content` at the editor's selection through the editor's own
 * handling of a paste, in one change: with its formatting when it has HTML,
 * except in code, where the editor pastes text alone, and as text otherwise.
 * Answers whether it had anything to paste.
 */
export function pasteInto(view: EditorView, { html, text }: ClipboardContent): boolean {
	const inCode = view.state.selection.$from.parent.type.spec.code === true;
	if (html !== "" && !(inCode && text !== "")) return view.pasteHTML(html);
	return text !== "" && view.pasteText(text);
}

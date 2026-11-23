import type { Node } from "@tiptap/pm/model";
import { type Editor, useEditorState } from "@tiptap/react";
import { cn } from "cn";

/** A heading of the document, and where it starts. */
interface Heading {
	pos: number;
	level: 2 | 3;
	text: string;
}

/**
 * The document's headings beside its text, each scrolling to its own, where
 * the page is wide enough to have room for them: full screen, or a wide pane.
 * It stays put while the text scrolls. The title, a level 1 heading, is left
 * out, as the page opens on it.
 */
export function Outline({ editor }: { editor: Editor }) {
	const headings = useEditorState({
		editor,
		selector: ({ editor: current }) => headingsOf(current.state.doc),
		equalityFn: (before, after) => JSON.stringify(before) === JSON.stringify(after),
	});
	// One heading is no outline.
	if (headings.length < 2) return null;
	function show(pos: number) {
		const heading = editor.view.nodeDOM(pos);
		if (heading instanceof HTMLElement)
			heading.scrollIntoView({ behavior: "smooth", block: "start" });
	}
	return (
		// No height, so the text keeps the whole page and this floats in its margin.
		<div className="pointer-events-none sticky top-0 z-1 hidden h-0 @7xl:block">
			<nav
				aria-label="On this page"
				className="pointer-events-auto absolute top-14 left-6 flex w-48 flex-col gap-0.5"
			>
				<span className="px-2 pb-1.5 text-subtle-foreground text-xs">On this page</span>
				{headings.map(({ pos, level, text }) => (
					<button
						key={pos}
						type="button"
						onClick={() => show(pos)}
						className={cn(
							"focus-ring truncate rounded-md py-1 pr-2 text-left text-muted-foreground text-xs transition-colors hover:bg-hover hover:text-foreground",
							level === 3 ? "pl-5" : "pl-2",
						)}
					>
						{text}
					</button>
				))}
			</nav>
		</div>
	);
}

function headingsOf(document: Node): Heading[] {
	const headings: Heading[] = [];
	document.forEach((block, pos) => {
		const level: unknown = block.attrs.level;
		const text = block.textContent.trim();
		if (block.type.name !== "heading" || text === "") return;
		if (level === 2 || level === 3) headings.push({ pos, level, text });
	});
	return headings;
}

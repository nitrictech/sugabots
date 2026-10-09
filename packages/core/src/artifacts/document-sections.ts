/** A markdown heading and the lines it spans, up to the next heading at its level or above. */
interface Section {
	heading: string;
	level: number;
	startLine: number;
	endLine: number;
}

export type SectionReplacement =
	| { ok: true; markdown: string }
	| { ok: false; reason: "missing" | "ambiguous"; headings: string[] };

const ATX_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * `markdown` with the section under `heading` replaced by `replacement`, which
 * includes its own heading line. A heading is matched by its text, ignoring
 * case and any leading `#`s, so "## Goals" and "goals" both find `## Goals`.
 * Fails, listing the document's headings, when none or more than one match.
 */
export function replaceSection(
	markdown: string,
	heading: string,
	replacement: string,
): SectionReplacement {
	const lines = markdown.split("\n");
	const sections = sectionsOf(lines);
	const wanted = normalise(heading.replace(/^#+\s*/, ""));
	const matches = sections.filter((section) => normalise(section.heading) === wanted);
	const [match] = matches;
	if (!match || matches.length > 1) {
		return {
			ok: false,
			reason: match ? "ambiguous" : "missing",
			headings: sections.map((section) => `${"#".repeat(section.level)} ${section.heading}`),
		};
	}
	const replaced = [
		...lines.slice(0, match.startLine),
		...replacement.replace(/\n+$/, "").split("\n"),
		...(match.endLine < lines.length ? [""] : []),
		...lines.slice(match.endLine),
	];
	return { ok: true, markdown: replaced.join("\n") };
}

function sectionsOf(lines: readonly string[]): Section[] {
	const headings: Omit<Section, "endLine">[] = [];
	let inFence = false;
	lines.forEach((line, index) => {
		if (FENCE.test(line)) inFence = !inFence;
		if (inFence) return;
		const found = ATX_HEADING.exec(line);
		if (found?.[1] && found[2] !== undefined) {
			headings.push({ heading: found[2], level: found[1].length, startLine: index });
		}
	});
	return headings.map((section, index) => {
		const next = headings.slice(index + 1).find((later) => later.level <= section.level);
		return { ...section, endLine: next?.startLine ?? lines.length };
	});
}

const normalise = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

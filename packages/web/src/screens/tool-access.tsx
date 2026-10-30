import type { ConnectionAccess, ToolAccessCounts } from "@sugabots/contracts";
import { SegmentedControl } from "@/ui/segmented-control.tsx";

/*
 * Allowed, Ask first and Off as a connection's settings show them: a line
 * summing up its tools for the pod's list, and a pick-one row for a tool, or
 * a kind of tool, on the connection's own page.
 */

const ACCESSES = ["allow", "ask", "off"] as const;

/** A setting in words, as a connection's own page puts it: Allowed, Ask first, Off. */
export const ACCESS_WORDS: Record<ConnectionAccess, string> = {
	allow: "Allowed",
	ask: "Ask first",
	off: "Off",
};

const toolOptions = ACCESSES.map((value) => ({ value, label: ACCESS_WORDS[value] }));

/** How many of a connection's tools are at each setting, in the order the sentence gives them. */
const COUNTED: { access: ConnectionAccess; words: string }[] = [
	{ access: "allow", words: "allowed" },
	{ access: "ask", words: "ask first" },
	{ access: "off", words: "off" },
];

/**
 * What a connection's tools amount to, in a line: the setting they share, or
 * how many are at each when they differ. Undefined while it has no tools.
 */
export function accessSummaryText(counts: ToolAccessCounts): string | undefined {
	const total = counts.allow + counts.ask + counts.off;
	if (total === 0) return undefined;
	switch (ACCESSES.find((access) => counts[access] === total)) {
		case "allow":
			return "Every tool runs without asking";
		case "ask":
			return "Every tool asks first";
		case "off":
			return "Off for every bot";
		case undefined: {
			const parts = COUNTED.filter(({ access }) => counts[access] > 0).map(
				({ access, words }) => `${counts[access]} ${words}`,
			);
			return `Custom: ${parts.join(", ")}`;
		}
	}
}

/**
 * Allowed, Ask first or Off for one tool, or for a kind of tool at once.
 * Somebody who may not change it reads the setting instead.
 */
export function AccessToggle({
	label,
	value,
	canManage,
	onChange,
}: {
	/** What it sets, which names the control: a tool's name, or Tools that read. */
	label: string;
	value: ConnectionAccess;
	canManage: boolean;
	onChange: (access: ConnectionAccess) => void;
}) {
	if (!canManage) {
		return (
			<span className="shrink-0 text-[13px] text-muted-foreground">{ACCESS_WORDS[value]}</span>
		);
	}
	return <SegmentedControl label={label} options={toolOptions} value={value} onChange={onChange} />;
}

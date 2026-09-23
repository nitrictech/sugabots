import type { ToolCallPart } from "@sugabots/contracts";
import { useEffect, useState } from "react";
import preview from "#storybook/preview";
import type { ConnectionLook } from "@/lib/connections.ts";
import { TypingIndicator } from "./TypingIndicator.tsx";
import { toolActivityOf } from "./tool-activity.ts";

const agent = { name: "Personal Assistant", hue: 210, face: "bar" as const };

const looks = new Map<string, ConnectionLook>([
	["sentry", { name: "Sentry", presetId: "sentry", hue: 350 }],
	// No catalog entry, so this one is marked with its letters rather than a logo.
	["acme", { name: "Acme CRM", hue: 120 }],
]);

const names = new Map([...looks].map(([handle, look]) => [handle, look.name]));

/*
 * The elapsed time on this line counts from `startedAt` against the clock, so
 * these stories start it at render time rather than at a fixed instant — a
 * fixed one would show years, not seconds. The last call is the one running.
 */
function working(...tools: string[]) {
	const now = new Date().toISOString();
	const calls = tools.map((tool, index): ToolCallPart => {
		const running = index === tools.length - 1;
		return {
			type: "tool_call",
			id: `0199a3a0-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
			tool,
			input: { query: "timeout" },
			output: null,
			status: running ? "running" : "completed",
			error: null,
			mutating: false,
			atOffset: 0,
			startedAt: now,
			finishedAt: running ? null : now,
		};
	});
	return toolActivityOf({ parts: calls }, names);
}

const QUICK_STEPS = [
	"sentry__search_issues",
	"sentry__get_issue",
	"sentry__get_event",
	"acme__list_deals",
	"web_search",
];

/** Makes a quick call every `QUICK_STEP_MS`, faster than the line lets a step go. */
const QUICK_STEP_MS = 250;

function QuickSteps() {
	const [made, setMade] = useState(1);
	useEffect(() => {
		const next = setInterval(() => setMade((count) => count + 1), QUICK_STEP_MS);
		return () => clearInterval(next);
	}, []);
	const rounds = Math.ceil(made / QUICK_STEPS.length);
	const tools = Array.from({ length: rounds }, () => QUICK_STEPS)
		.flat()
		.slice(0, made);
	return <TypingIndicator agent={agent} activity={working(...tools)} looks={looks} />;
}

const meta = preview.meta({
	title: "Product/TypingIndicator",
	component: TypingIndicator,
	tags: ["ai-generated"],
	args: { agent, looks },
	decorators: [
		(Story) => (
			<div className="mx-auto max-w-home py-4">
				<Story />
			</div>
		),
	],
});

/** Before any tool, or between them: the agent is typing. */
export const Typing = meta.story({});

/** Asked another agent, and waiting to hear back. */
export const WaitingOnACollaborator = meta.story({ args: { waitingOn: "Issue Triager" } });

/** A service with a logo in the catalogue: the mark stands in for its name. */
export const OnAConnection = meta.story({ args: { activity: working("sentry__search_issues") } });

/** A server with no catalogue entry, marked with its letters instead. */
export const OnAnUnlistedConnection = meta.story({
	args: { activity: working("acme__list_deals") },
});

/** A connection the pod no longer has: no mark to draw, so its handle is written out. */
export const ConnectionSinceRemoved = meta.story({
	args: { activity: working("sentry__search_issues"), looks: undefined },
});

/** One of the product's own tools, which is no one's service and carries no mark. */
export const ABuiltInTool = meta.story({ args: { activity: working("web_search") } });

/** On the side the agent's own bubbles are on, in a one-to-one chat. */
export const OnTheAgentsSide = meta.story({
	args: { activity: working("sentry__search_issues"), outgoing: true },
});

/**
 * A call every quarter second: each step the line names stays for a second,
 * and the ones that came and went in between are skipped rather than queued.
 */
export const ABurstOfQuickSteps = meta.story({
	render: () => <QuickSteps />,
});

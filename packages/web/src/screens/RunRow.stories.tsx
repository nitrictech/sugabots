import type { RunTriggerKind } from "@sugabots/contracts";
import { fn } from "storybook/test";
import preview from "#storybook/preview";
import type { WorkState } from "@/lib/work-state.ts";
import { RunRow } from "./RunRow.tsx";

const meta = preview.meta({
	title: "Product/RunRow",
	component: RunRow,
	tags: ["ai-generated"],
});

/** When each run started. */
const STARTED_AT = "2026-09-25T06:12:00.000Z";

const run = (state: WorkState, triggerKind: RunTriggerKind = "routine") => (
	<RunRow
		automationName="Overnight outbound"
		triggerKind={triggerKind}
		state={state}
		at={STARTED_AT}
		onOpen={fn()}
	/>
);

/**
 * AutomationRan is a routine's run that finished without posting into the
 * chat, marked with a clock and the time it started.
 */
export const AutomationRan = meta.story({ render: () => run("done") });

/** AutomationRanFromWebhook is a run its webhook started, marked with a hook in the clock's place. */
export const AutomationRanFromWebhook = meta.story({ render: () => run("done", "webhook") });

/** AutomationFailed marks the failure with the one red the design allows. */
export const AutomationFailed = meta.story({ render: () => run("failed") });

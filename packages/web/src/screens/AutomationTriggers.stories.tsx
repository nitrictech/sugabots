import type { AutomationTriggerInput } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect, fn, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk } from "@/shell/story-fixtures.test-support.ts";
import { Dialog } from "@/ui/dialog.tsx";
import { buildTriggerDraft, TriggerDialog, TriggersGroup } from "./AutomationTriggers.tsx";

/*
 * An automation's routines and other triggers, as its settings list them, and
 * the dialog that changes one.
 */

const weekdayMornings: AutomationTriggerInput = {
	kind: "routine",
	schedule: {
		repeat: "weekly",
		every: 1,
		days: ["mon", "tue", "wed", "thu", "fri"],
		times: [9 * 60],
		startsOn: "2026-09-01",
	},
	timezone: "UTC",
};

const dailyEvening: AutomationTriggerInput = {
	kind: "routine",
	schedule: { repeat: "daily", every: 1, times: [18 * 60], startsOn: "2026-09-01" },
	timezone: "UTC",
};

const routines = [
	{ key: "weekday-mornings", trigger: weekdayMornings },
	{ key: "daily-evening", trigger: dailyEvening },
];

const meta = preview.meta({
	title: "Product/Automation Triggers",
	component: TriggersGroup,
	args: {
		section: "routines",
		triggers: routines,
		editable: true,
		onOpen: fn(),
		onAdd: fn(),
	},
});

/** Routines, each opening to change, then a row adding another. */
export const Routines = meta.story({
	play: async ({ canvas, args, userEvent }) => {
		const group = canvas.getByRole("region", { name: "Routines" });
		const rows = within(group).getAllByRole("button");
		// Each routine, then Add routine.
		await expect(rows).toHaveLength(routines.length + 1);
		await userEvent.click(rows[0] as HTMLElement);
		await expect(args.onOpen).toHaveBeenCalledWith("weekday-mornings");
		await userEvent.click(within(group).getByRole("button", { name: /Add routine/ }));
		await expect(args.onAdd).toHaveBeenCalled();
	},
});

/** NothingStartsIt is an automation with no routine or trigger: it says it runs only by hand. */
export const NothingStartsIt = meta.story({
	args: { section: "triggers", triggers: [] },
	play: async ({ canvas }) => {
		await expect(canvas.getByText("No triggers")).toBeVisible();
		await expect(canvas.getByText("It runs only when someone runs it.")).toBeVisible();
	},
});

/** ReadOnly is for someone who may not change the automation: rows that open nothing, and no Add. */
export const ReadOnly = meta.story({
	args: { editable: false },
	play: async ({ canvas }) => {
		await expect(canvas.queryByRole("button")).toBeNull();
	},
});

const removeRoutine = fn(async () => {});

/** EditingARoutine opens a routine to change, with Save and Remove. */
export const EditingARoutine = meta.story({
	decorators: [
		function WithQueries(Story) {
			const [client] = useState(() => new QueryClient());
			return (
				<QueryClientProvider client={client}>
					<Story />
				</QueryClientProvider>
			);
		},
	],
	render: () => (
		<Dialog open>
			<TriggerDialog
				owner={{ bot: growthDesk }}
				editing={buildTriggerDraft(weekdayMornings)}
				onSave={fn(async () => {})}
				onRemove={removeRoutine}
				done={fn()}
			/>
		</Dialog>
	),
	play: async ({ userEvent }) => {
		const dialog = await screen.findByRole("dialog");
		await expect(within(dialog).getByRole("button", { name: "Save" })).toBeVisible();
		await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
		await expect(removeRoutine).toHaveBeenCalled();
	},
});

import type { Agent, Pod, Routine, WorkspaceRoutine } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
// A dialog is portalled to the body, so reaching it means `screen` rather
// than the story's own canvas.
import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import {
	accountManager,
	chief,
	engineering,
	growthDesk,
	leadResearcher,
	linearHandler,
	oncall,
	personal,
	revenue,
} from "@/shell/story-fixtures.ts";
import { WorkspaceRoutinesSettings } from "./RoutinesSettings.tsx";

const workspace = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Nitric",
	slug: "nitric",
	createdAt: "2026-09-01T00:00:00.000Z",
};

function placed(
	n: number,
	name: string,
	agent: Agent,
	pod: Pod,
	trigger: Routine["trigger"],
	state: Routine["state"] = "enabled",
): WorkspaceRoutine {
	return {
		routine: {
			id: `0199a3a0-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`,
			workspaceId: workspace.id,
			agentId: agent.id,
			name,
			instructions: `${name}: look over what changed and post a short summary.`,
			trigger,
			state,
			createdById: null,
			createdAt: "2026-09-01T00:00:00.000Z",
			updatedAt: "2026-09-01T00:00:00.000Z",
		},
		agent,
		pod: { id: pod.id, slug: pod.slug },
	};
}

const cron = (expression: string): Routine["trigger"] => ({
	kind: "cron",
	expression,
	timezone: "UTC",
	nextScheduledAt: null,
});

const overnight = placed(1, "Overnight outbound", growthDesk, revenue, cron("0 6 * * *"));
const morningBrief = placed(2, "Morning brief", chief, personal, cron("0 8 * * 1-5"));
const churnReport = placed(
	3,
	"Weekly churn report",
	accountManager,
	revenue,
	cron("0 9 * * 1"),
	"paused",
);
const incidentIntake = placed(4, "Incident intake", oncall, engineering, { kind: "webhook" });

function RoutinesPreview({ items, children }: { items: WorkspaceRoutine[]; children: ReactNode }) {
	const [queryClient] = useState(() => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(["workspaces"], [workspace]);
		client.setQueryData(["pods", workspace.id], [revenue, engineering, personal]);
		client.setQueryData(
			["agents", workspace.id],
			[growthDesk, accountManager, leadResearcher, linearHandler, oncall, chief],
		);
		client.setQueryData(["routines", "workspace", workspace.id], { items });
		return client;
	});
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex min-h-screen flex-col bg-background">{children}</div>
		</QueryClientProvider>
	);
}

const meta = preview.meta({
	title: "Views/RoutinesSettings",
	component: WorkspaceRoutinesSettings,
	tags: ["ai-generated"],
	args: { workspaceId: workspace.id },
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "720px" } },
		routines: [overnight, morningBrief, churnReport, incidentIntake],
	},
	decorators: [
		(Story, context) => (
			<RoutinesPreview key={context.id} items={context.parameters.routines}>
				<Story />
			</RoutinesPreview>
		),
	],
});

/** Each routine with when it runs and its bot, and a switch for whether it is on. */
export const Listing = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Every day at 6:00, Growth Desk")).toBeInTheDocument();
		await expect(canvas.getByText("Weekdays at 8:00, Chief")).toBeInTheDocument();
		await expect(canvas.getByText("When its address is called, On-call")).toBeInTheDocument();
		await expect(canvas.getByRole("switch", { name: "Weekly churn report on" })).not.toBeChecked();
		await expect(
			canvas.getByText("Routines post into the bot's chat when they run."),
		).toBeInTheDocument();
	},
});

/** Nothing made yet: one line saying what a routine is, and New routine above it. */
export const Empty = meta.story({
	parameters: { routines: [] },
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("No routines yet")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "New routine" })).toBeInTheDocument();
	},
});

/** A new routine starts on a daily schedule at 9:00, and waits for a name and instructions. */
export const NewRoutine = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "New routine" }));
		const dialog = await screen.findByRole("dialog", { name: "New routine" });

		await expect(within(dialog).getByRole("radio", { name: "Every day" })).toBeChecked();
		await expect(within(dialog).getByText("9:00")).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
		await expect(
			within(dialog).getByText(/Runs every day at 9:00 and posts the result in Growth Desk's chat/),
		).toBeInTheDocument();
	},
});

/** Weekly adds a row of days to pick from. */
export const Weekly = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "New routine" }));
		const dialog = await screen.findByRole("dialog", { name: "New routine" });
		await userEvent.click(within(dialog).getByRole("radio", { name: "Weekly" }));
		await userEvent.click(within(dialog).getByRole("checkbox", { name: "Friday" }));

		await expect(within(dialog).getByRole("checkbox", { name: "Monday" })).toBeChecked();
		await expect(within(dialog).getByText(/Runs Mondays and Fridays at 9:00/)).toBeInTheDocument();
	},
});

/** A webhook's address is made when the routine is saved. */
export const Webhook = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "New routine" }));
		const dialog = await screen.findByRole("dialog", { name: "New routine" });
		await userEvent.click(within(dialog).getByRole("radio", { name: "Webhook" }));

		await expect(within(dialog).getByText("Made when you save")).toBeInTheDocument();
		await expect(
			within(dialog).getByText(/Runs whenever the address is called/),
		).toBeInTheDocument();
	},
});

/** The bot picker lists bots under their pods, with the chosen one ticked. */
export const ChoosingABot = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "New routine" }));
		const dialog = await screen.findByRole("dialog", { name: "New routine" });
		await userEvent.click(within(dialog).getByRole("button", { name: "Bot" }));
		const picker = await screen.findByRole("dialog", { name: "Bot" });

		await expect(within(picker).getByRole("heading", { name: "Engineering" })).toBeInTheDocument();
		await expect(within(picker).getByRole("button", { name: "Growth Desk" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	},
});

/** An existing routine opens with its bot fixed, and Delete routine at the foot. */
export const Editing = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: /Overnight outbound/ }));
		const dialog = await screen.findByRole("dialog", { name: "Edit routine" });

		await expect(within(dialog).getByLabelText("Name")).toHaveValue("Overnight outbound");
		await expect(within(dialog).queryByRole("button", { name: "Bot" })).toBeNull();
		await expect(within(dialog).getByText("6:00")).toBeInTheDocument();
		await expect(
			within(dialog).getByRole("button", { name: "Delete routine" }),
		).toBeInTheDocument();
	},
});

import type { Agent, Pod, Routine, WorkspaceRoutine } from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import {
	accountManager,
	chief,
	engineering,
	growthDesk,
	oncall,
	personal,
	revenue,
} from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyPods, storyWorkspace } from "../story-app.tsx";

/*
 * Routines in settings: every routine beside the open one, or the one being
 * made. On a phone the open routine covers the list, with the way back to it.
 */

const API = import.meta.env.VITE_API_URL as string;
const routines = `/${storyWorkspace.slug}/settings/routines`;
const PHONE = { viewport: { value: "iphone12", isRotated: false } };

function placed(
	n: number,
	name: string,
	agent: Agent,
	pod: Pod,
	trigger: Routine["trigger"],
	fields: Partial<Pick<Routine, "state" | "results">> = {},
): WorkspaceRoutine {
	return {
		routine: {
			id: `0199a3a0-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`,
			workspaceId: storyWorkspace.id,
			agentId: agent.id,
			name,
			instructions: `${name}: look over what changed and post a short summary.`,
			trigger,
			state: "enabled",
			results: "post_to_chat",
			createdById: null,
			createdAt: "2026-09-01T00:00:00.000Z",
			updatedAt: "2026-09-01T00:00:00.000Z",
			...fields,
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
	cron("0 9 * * 1,3,5"),
	{
		state: "paused",
	},
);
const incidentIntake = placed(
	4,
	"Incident intake",
	oncall,
	engineering,
	{ kind: "webhook", auth: { kind: "bearer" } },
	{ results: "keep_in_run" },
);
const everyRoutine = [overnight, morningBrief, churnReport, incidentIntake];

const routinesAnswer = (items: WorkspaceRoutine[]) =>
	http.get(`${API}/workspaces/:workspace/routines`, () => HttpResponse.json({ items }));

const pageOf = (one: WorkspaceRoutine) => `${routines}/${one.routine.id}`;

const meta = preview.meta({
	title: "Views/Routines",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(routinesAnswer(everyRoutine), ...appHandlers());
	},
});

/** Every routine with when it runs and its bot, beside the first one. */
export const List = meta.story({
	render: () => <StoryApp path={routines} />,
	play: async ({ canvas }) => {
		const list = await canvas.findByRole(
			"navigation",
			{ name: "Workspace routines" },
			{ timeout: 10_000 },
		);
		await expect(
			await within(list).findByText("Every day at 6:00, Growth Desk"),
		).toBeInTheDocument();
		await expect(within(list).getByText("When its address is called, On-call")).toBeInTheDocument();
		await expect(within(list).getByText("Paused")).toBeInTheDocument();
		await expect(
			await canvas.findByRole("heading", { name: "Overnight outbound" }),
		).toBeInTheDocument();
	},
});

/** A scheduled routine: on, with its bot, its schedule, where its result goes, and Run now. */
export const Scheduled = meta.story({
	render: () => <StoryApp path={pageOf(overnight)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Overnight outbound" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByText("Growth Desk · Revenue pod")).toBeInTheDocument();
		await expect(canvas.getByRole("switch", { name: "Runs on its own" })).toBeChecked();
		await expect(canvas.getByRole("radio", { name: "Every day" })).toBeChecked();
		await expect(canvas.getByRole("button", { name: "Run now" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Delete routine" })).toBeInTheDocument();
	},
});

/** Instructions open on a page of their own, with room to write and Save, as a bot's do. */
export const Instructions = meta.story({
	render: () => <StoryApp path={pageOf(overnight)} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: /^Instructions/ }, { timeout: 10_000 }),
		);
		await expect(await canvas.findByLabelText("Instructions")).toHaveValue(
			overnight.routine.instructions,
		);
		await expect(canvas.getByRole("button", { name: "Save" })).toBeDisabled();
		await expect(canvas.getByRole("button", { name: "Overnight outbound" })).toBeInTheDocument();
	},
});

/** Paused: it says it runs only when asked, and Run now still works. */
export const Paused = meta.story({
	render: () => <StoryApp path={pageOf(churnReport)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(
				"Paused. It only runs when you press Run now.",
				{},
				{ timeout: 10_000 },
			),
		).toBeInTheDocument();
		await expect(canvas.getByRole("switch", { name: "Runs on its own" })).not.toBeChecked();
		await expect(canvas.getByRole("checkbox", { name: "Wednesday" })).toBeChecked();
	},
});

/** A webhook: its address, and its secret, which shows only in the tab that made it. */
export const Webhook = meta.story({
	render: () => <StoryApp path={pageOf(incidentIntake)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(
				new RegExp(`/hooks/routines/${incidentIntake.routine.id}$`),
				{},
				{ timeout: 10_000 },
			),
		).toBeInTheDocument();
		await expect(canvas.getByText("Shown only when it's made")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Reset" })).toBeInTheDocument();
	},
});

/**
 * A new routine starts on a daily schedule at 9:00 on the first bot, posting
 * its result to the chat, and waits for a name and instructions.
 */
export const NewRoutine = meta.story({
	render: () => <StoryApp path={`${routines}/new`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "New routine" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByText("Not created yet")).toBeInTheDocument();
		await expect(canvas.getByRole("radio", { name: "Every day" })).toBeChecked();
		await expect(canvas.getByText("9:00")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Create routine" })).toBeDisabled();
		await expect(canvas.queryByRole("switch", { name: "Runs on its own" })).toBeNull();
	},
});

/** Weekly adds a row of days, and the bot list opens in place under its pods. */
export const ChoosingDaysAndABot = meta.story({
	render: () => <StoryApp path={`${routines}/new`} />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			await canvas.findByRole("radio", { name: "Weekly" }, { timeout: 10_000 }),
		);
		await userEvent.click(canvas.getByRole("checkbox", { name: "Friday" }));
		await expect(canvas.getByText(/Runs Mondays and Fridays at 9:00/)).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: /^Bot/ }));
		await expect(canvas.getByRole("heading", { name: "Engineering" })).toBeInTheDocument();
	},
});

/** Somebody who may not manage a pod's routines reads them without the controls to change them. */
export const AsAMember = meta.story({
	beforeEach({ msw }) {
		const asMember = storyPods.map((pod) => ({
			...pod,
			permissions: { ...pod.permissions, manageRoutines: false, runRoutines: false },
		}));
		msw.use(routinesAnswer(everyRoutine), ...appHandlers({ role: "member", pods: asMember }));
	},
	render: () => <StoryApp path={pageOf(overnight)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Overnight outbound" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("switch", { name: "Runs on its own" })).toBeDisabled();
		await expect(canvas.queryByRole("button", { name: "Run now" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Delete routine" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "New routine" })).toBeNull();
	},
});

/** Nothing made yet: what a routine is, and New routine. */
export const Empty = meta.story({
	beforeEach({ msw }) {
		msw.use(routinesAnswer([]), ...appHandlers());
	},
	render: () => <StoryApp path={routines} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText("No routines yet", {}, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getAllByRole("button", { name: "New routine" }).length).toBeGreaterThan(0);
	},
});

/** On a phone the list stands alone. */
export const PhoneList = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={routines} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("navigation", { name: "Workspace routines" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("heading", { name: "Overnight outbound" })).toBeNull();
	},
});

/** On a phone the open routine covers the list, with the way back to it. */
export const PhoneRoutine = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={pageOf(churnReport)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: "Routines" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(
			await canvas.findByRole("heading", { name: "Weekly churn report" }),
		).toBeInTheDocument();
	},
});

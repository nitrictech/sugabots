import type { UsageMonth, WorkspaceUsage } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { UsageSettings } from "./UsageSettings.tsx";

const workspace = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Suga Workspace",
	slug: "suga",
	timeZone: "UTC",
	createdAt: "2026-09-01T00:00:00.000Z",
};

const usageUrl = `${import.meta.env.VITE_API_URL}/workspaces/${workspace.id}/usage`;

/** The design's day-by-day shape, in dollars, for the days of September so far. */
const SEPTEMBER_DAYS = [
	1.9, 3.1, 2.6, 3.8, 3.5, 0.9, 0.6, 3.2, 4.4, 4.7, 4.1, 3.6, 1.0, 0.8, 3.7, 5.1, 5.6, 4.6, 4.9,
	1.4, 1.0, 4.3, 5.4, 6.0, 4.9,
];

const days = (month: UsageMonth, spent: readonly number[], length: number) =>
	Array.from({ length }, (_, index) => ({
		date: `${month}-${String(index + 1).padStart(2, "0")}`,
		usd: spent[index] ?? 0,
	}));

const september: WorkspaceUsage = {
	month: "2026-09",
	timeZone: "UTC",
	usd: 94.2,
	unpricedRequests: 0,
	days: days("2026-09", SEPTEMBER_DAYS, 30),
	bots: [
		bot("Growth Desk", "green", "pill", "Revenue", 30.14),
		bot("Linear Handler", "orange", "square", "Engineering", 16.01),
		bot("Chief", "purple", "arc", "Personal", 13.19),
		bot("Account Manager", "sky", "dot", "Revenue", 10.36),
		bot("Lead Researcher", "ice", "wink", "Revenue", 7.54),
		bot("On-call", "rose", "dot", "Engineering", 4.71),
		bot("Inbox Manager", "yellow", "pill", "Personal", 3.77),
		bot("Scheduler", "teal", "square", "Personal", 2.83),
	],
	models: [
		model("claude-sonnet-4-5", "Claude Sonnet", "Anthropic", "anthropic", 47.1),
		// The bots' $16.01 and the system agents' $5.65, together.
		model("claude-haiku-4-5", "Claude Haiku", "Anthropic", "anthropic", 21.66),
		model("gpt-5", "GPT-5", "OpenAI", "openai", 18.84),
		model("deepseek/deepseek-v3", "DeepSeek V3", "OpenRouter", "openrouter", 6.59),
		model(
			"anthropic/claude-haiku-4.5",
			"Anthropic: Claude Haiku 4.5",
			"OpenRouter",
			"openrouter",
			0.004,
		),
		model("qwen3.5:4b", "Qwen 3.5 4B", "Ollama", "ollama", 0),
	],
	pods: [
		pod("Revenue", "green", 3, 48.04),
		pod("Engineering", "orange", 2, 20.72),
		pod("Personal", "purple", 3, 19.78),
	],
	systemAgents: { usd: 5.65, unpricedRequests: 0 },
};

function bot(
	name: string,
	color: WorkspaceUsage["bots"][number]["color"],
	face: WorkspaceUsage["bots"][number]["face"],
	podName: string,
	usd: number,
) {
	return { agentId: `bot-${name}`, name, color, face, podName, usd, unpricedRequests: 0 };
}

function model(
	id: string,
	displayName: string,
	providerName: string,
	preset: WorkspaceUsage["models"][number]["preset"],
	usd: number,
) {
	return {
		model: id,
		displayName,
		providerName,
		preset,
		usd,
		unpricedRequests: 0,
	};
}

function pod(
	name: string,
	color: WorkspaceUsage["pods"][number]["color"],
	botCount: number,
	usd: number,
) {
	return { podId: `pod-${name}`, name, color, botCount, usd, unpricedRequests: 0 };
}

const august: WorkspaceUsage = {
	...september,
	month: "2026-08",
	usd: 61.3,
	days: days("2026-08", SEPTEMBER_DAYS.toReversed(), 31),
};

/** Answers with `months` by the month asked for, and with nothing spent for any other. */
const answering = (...months: WorkspaceUsage[]) =>
	http.get(usageUrl, ({ request }) => {
		const asked = new URL(request.url).searchParams.get("month") ?? "";
		const found = months.find((usage) => usage.month === asked);
		return HttpResponse.json(found ?? nothingSpent(asked));
	});

const nothingSpent = (month: string): WorkspaceUsage => ({
	month,
	timeZone: "UTC",
	usd: 0,
	unpricedRequests: 0,
	days: days(month, [], 30),
	bots: [],
	models: [],
	pods: [],
	systemAgents: { usd: 0, unpricedRequests: 0 },
});

function QueryPreview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex min-h-screen flex-col bg-background">{children}</div>
		</QueryClientProvider>
	);
}

/** Late on the 25th of September, so the last five days are still to come. */
const NOW = new Date("2026-09-25T20:00:00Z");

const meta = preview.meta({
	title: "Views/UsageSettings",
	component: UsageSettings,
	args: { now: NOW },
	parameters: {
		layout: "fullscreen",
		// Inline docs examples share MSW handlers; separate frames keep their responses independent.
		docs: { story: { inline: false, height: "900px" } },
	},
	decorators: [
		(Story, context) => (
			<QueryPreview key={context.id}>
				<Story />
			</QueryPreview>
		),
	],
	beforeEach({ msw }) {
		msw.use(
			http.get(`${import.meta.env.VITE_API_URL}/workspaces`, () => HttpResponse.json([workspace])),
			answering(september, august),
		);
	},
});

/**
 * The design's month: the total, a bar for each day so far, and the month by
 * bot, with the system agents last. The month still going can't be stepped past.
 */
export const ByBot = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("$94.20")).toBeInTheDocument();
		await expect(canvas.getByText("Growth Desk")).toBeInTheDocument();
		await expect(canvas.getByText("System agents")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Next month" })).toBeDisabled();
		await expect(
			canvas.getByText(
				"Estimated from each provider's published prices. Your provider bills you directly.",
			),
		).toBeInTheDocument();
	},
});

/**
 * By model, one line for each model through each provider, whoever asked it:
 * the same model through a gateway is a line of its own, and a local model
 * costs nothing.
 */
export const ByModel = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("radio", { name: "Model" }));
		await expect(canvas.getByText("Claude Sonnet")).toBeInTheDocument();
		await expect(canvas.getByText("Qwen 3.5 4B")).toBeInTheDocument();
		await expect(canvas.getByText("$0.00")).toBeInTheDocument();
		await expect(canvas.getByText("$21.66")).toBeInTheDocument();
		await expect(canvas.getByText("Anthropic: Claude Haiku 4.5")).toBeInTheDocument();
		await expect(canvas.getByText("<$0.01")).toBeInTheDocument();
	},
});

/** By pod, counting each pod's bots, with the system agents' work last. */
export const ByPod = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("radio", { name: "Pod" }));
		await expect(canvas.getByText("Revenue")).toBeInTheDocument();
		await expect(canvas.getAllByText("3 bots")).toHaveLength(2);
		await expect(canvas.getByText("$5.65")).toBeInTheDocument();
	},
});

/** Stepping back a month reads that month instead, and it can be stepped forward again. */
export const EarlierMonth = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Previous month" }));
		await expect(await canvas.findByText("$61.30")).toBeInTheDocument();
		await expect(canvas.getByText("Aug 2026")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Next month" })).toBeEnabled();
	},
});

/**
 * Some requests couldn't be priced, such as one to a model with no published
 * price. They are counted beneath the breakdown, and a bot whose every request
 * went unpriced shows a dash rather than a misleading $0.00.
 */
export const SomeUnpriced = meta.story({
	beforeEach({ msw }) {
		msw.use(
			answering({
				...september,
				unpricedRequests: 3,
				bots: [
					...september.bots,
					{ ...bot("Custom Endpoint", "teal", "wink", "Engineering", 0), unpricedRequests: 3 },
				],
			}),
		);
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(
				"Estimated from each provider's published prices. 3 requests couldn't be priced and aren't included. Your provider bills you directly.",
			),
		).toBeInTheDocument();
		await expect(canvas.getByText("Not priced")).toBeInTheDocument();
	},
});

/** A month nothing was spent in says so, rather than showing an empty list. */
export const NothingSpent = meta.story({
	beforeEach({ msw }) {
		msw.use(answering());
	},
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText("Nothing was spent in September 2026."),
		).toBeInTheDocument();
		await expect(canvas.getByText("$0.00")).toBeInTheDocument();
	},
});

/**
 * The month is the workspace's, not the viewer's: late on the 30th of
 * September in UTC is already October in a Sydney workspace.
 */
export const InWorkspaceTimeZone = meta.story({
	args: { now: new Date("2026-09-30T20:00:00Z") },
	beforeEach({ msw }) {
		msw.use(
			http.get(`${import.meta.env.VITE_API_URL}/workspaces`, () =>
				HttpResponse.json([{ ...workspace, timeZone: "Australia/Sydney" }]),
			),
			answering(),
		);
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Nothing was spent in October 2026.")).toBeInTheDocument();
	},
});

/**
 * A workspace in a time zone this browser doesn't have still shows its
 * spend: this month and today are taken in UTC instead.
 */
export const TimeZoneUnknownToBrowser = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${import.meta.env.VITE_API_URL}/workspaces`, () =>
				HttpResponse.json([{ ...workspace, timeZone: "Mars/Olympus" }]),
			),
		);
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("$94.20")).toBeInTheDocument();
	},
});

/** The API can't be reached: the page says why, and shows no numbers. */
export const Unavailable = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(usageUrl, () =>
				HttpResponse.json(
					{ _tag: "InternalServerError", message: "Usage is unavailable." },
					{ status: 500 },
				),
			),
		);
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("alert")).toBeInTheDocument();
		await expect(canvas.queryByText("$94.20")).not.toBeInTheDocument();
	},
});

import type {
	Artifact,
	ArtifactSummary,
	ArtifactVersionSummary,
	ToolCallPart,
} from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect, fn, screen, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue } from "@/shell/story-fixtures.ts";
import { ArtifactCards, ArtifactCardView, type WrittenArtifact } from "./ArtifactCards.tsx";
import { ArtifactListView, ArtifactStageView } from "./Artifacts.tsx";
import { FRAME_CONTENT_POLICY } from "./HtmlFrame.tsx";

const now = new Date("2026-10-01T09:30:00.000Z");
const scribe = { agentId: growthDesk.id, name: growthDesk.name };

const plan: ArtifactSummary = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	podId: revenue.id,
	kind: "document",
	title: "Q4 outreach plan",
	version: 3,
	createdBy: scribe,
	createdAt: "2026-09-29T07:00:00.000Z",
	updatedAt: "2026-10-01T08:10:00.000Z",
};

const dashboard: ArtifactSummary = {
	id: "0199a3a0-0000-7000-8000-0000000000f2",
	podId: revenue.id,
	kind: "html",
	title: "Pipeline by stage",
	version: 1,
	createdBy: null,
	createdAt: "2026-09-24T12:00:00.000Z",
	updatedAt: "2026-09-24T12:00:00.000Z",
};

const versions: ArtifactVersionSummary[] = [
	{ number: 3, author: scribe, createdAt: "2026-10-01T08:10:00.000Z" },
	{ number: 2, author: scribe, createdAt: "2026-09-30T15:00:00.000Z" },
	{ number: 1, author: scribe, createdAt: "2026-09-29T07:00:00.000Z" },
];

const planContent = `# Q4 outreach plan

## Goals

- Book 40 discovery calls with mid-market accounts.
- Reactivate the 12 stalled Proposal-stage deals.

## Risks

| Risk | Owner |
| --- | --- |
| Holiday slowdown in December | Growth Desk |
| Pricing page still in review | Kim |
`;

const atVersion = (summary: ArtifactSummary, number: number, content: string): Artifact => ({
	...summary,
	content,
	shownVersion: versions.find((version) => version.number === number) ?? {
		number,
		author: summary.createdBy,
		createdAt: summary.createdAt,
	},
});

const pageContent = `<!doctype html>
<html><head><style>body{font:16px system-ui;margin:24px} .bar{background:#6b5cff;height:18px;margin:6px 0}</style></head>
<body><h2>Pipeline by stage</h2>
<div class="bar" style="width:80%"></div><div class="bar" style="width:55%"></div><div class="bar" style="width:20%"></div>
<script>document.body.insertAdjacentHTML("beforeend", "<p id=ran>Drawn by the page's own script.</p>")</script>
</body></html>`;

const meta = preview.meta({
	title: "Views/Artifacts",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story) => (
			<div className="flex h-[640px] min-w-0">
				<Story />
			</div>
		),
	],
});

/**
 * A pod's artifacts, newest first under the month each was last updated in,
 * each with who made it and when, and a menu to download it. Each opens beside
 * the chat of the bot that made it.
 */
export const List = meta.story({
	args: { onDownload: fn() },
	render: ({ onDownload }) => (
		<ArtifactListView
			pod={revenue}
			artifacts={[plan, dashboard]}
			agents={[growthDesk]}
			now={now}
			download={{ onDownload }}
		/>
	),
	play: async ({ args, canvas, userEvent }) => {
		await expect(canvas.getByRole("link", { name: /Q4 outreach plan/ })).toHaveAttribute(
			"href",
			expect.stringContaining(`/agents/${growthDesk.handle}?artifact=${plan.id}`),
		);
		// Its bot has been removed, so it opens on a page of its own.
		await expect(canvas.getByRole("link", { name: /Pipeline by stage/ })).toHaveAttribute(
			"href",
			expect.stringContaining(`/artifacts/${dashboard.id}`),
		);
		const september = canvas.getByRole("region", { name: "September" });
		await expect(within(september).getByText("By a removed bot")).toBeVisible();
		await expect(within(september).getByText("Updated Sep 24")).toBeVisible();
		await expect(canvas.getByRole("region", { name: "October" })).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "More for Pipeline by stage" }));
		await expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
		await userEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
		await expect(args.onDownload).toHaveBeenCalledWith(dashboard.id);
	},
});

/** Those who manage the pod can delete one from its menu, once they confirm it. */
export const ListDelete = meta.story({
	args: { onDelete: fn() },
	render: ({ onDelete }) => (
		<ArtifactListView
			pod={revenue}
			artifacts={[plan, dashboard]}
			agents={[growthDesk]}
			now={now}
			download={{ onDownload: fn() }}
			deletion={{ pending: false, onDelete }}
		/>
	),
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "More for Q4 outreach plan" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
		const dialog = await screen.findByRole("dialog", { name: "Delete Q4 outreach plan?" });
		await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		await expect(args.onDelete).toHaveBeenCalledWith(plan.id, expect.any(Function));
	},
});

/** A download that failed says so above the list. */
export const ListDownloadFailed = meta.story({
	render: () => (
		<ArtifactListView
			pod={revenue}
			artifacts={[plan, dashboard]}
			agents={[growthDesk]}
			now={now}
			download={{ error: "The API did not answer.", onDownload: fn() }}
		/>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByText(/Could not download it/)).toBeVisible();
	},
});

/** Before any bot has made one, the page says how one gets here. */
export const Empty = meta.story({
	render: () => (
		<ArtifactListView
			pod={revenue}
			artifacts={[]}
			agents={[growthDesk]}
			now={now}
			download={{ onDownload: fn() }}
		/>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByText(`No artifacts in ${revenue.name} yet`)).toBeVisible();
	},
});

/** A document opened large at its current version, drawn as markdown, with who wrote it and when. */
export const Document = meta.story({
	render: () => (
		<ArtifactStageView
			pod={revenue}
			artifact={atVersion(plan, 3, planContent)}
			versions={versions}
			now={now}
			onVersionChange={fn()}
			onClose={fn()}
		/>
	),
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByRole("heading", { name: "Risks" })).toBeVisible();
		await expect(
			canvas.getByText(
				(_, element) =>
					/^Growth Desk \S/.test(element?.textContent ?? "") && element?.tagName === "P",
			),
		).toBeVisible();
		await expect(canvas.getByRole("button", { name: /Version 3/ })).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "More" }));
		await expect(await screen.findByRole("menuitem", { name: "Download" })).toBeVisible();
		await expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
		await expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
	},
});

/** Those who manage the pod can delete an artifact, once they confirm it. */
export const Delete = meta.story({
	args: { onDelete: fn() },
	render: ({ onDelete }) => (
		<ArtifactStageView
			pod={revenue}
			artifact={atVersion(plan, 3, planContent)}
			versions={versions}
			now={now}
			onVersionChange={fn()}
			onClose={fn()}
			deletion={{ pending: false, onDelete }}
		/>
	),
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "More" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
		const dialog = await screen.findByRole("dialog", { name: "Delete Q4 outreach plan?" });
		await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		await expect(args.onDelete).toHaveBeenCalled();
	},
});

/** An earlier version says which of how many it is, and choosing the newest goes back to the current one. */
export const EarlierVersion = meta.story({
	args: { onVersionChange: fn() },
	render: ({ onVersionChange }) => (
		<ArtifactStageView
			pod={revenue}
			artifact={atVersion(plan, 1, "# Q4 outreach plan\n\n## Goals\n\nTo be decided.\n")}
			versions={versions}
			now={now}
			onVersionChange={onVersionChange}
			onClose={fn()}
		/>
	),
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Version 1 of 3/ }));
		await userEvent.click(await screen.findByRole("menuitem", { name: /Version 3/ }));
		await expect(args.onVersionChange).toHaveBeenCalledWith(undefined);
		// The accessibility check after the story would otherwise catch the
		// menu's focus guards while it is still closing.
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	},
});

/**
 * An HTML page runs in a sandboxed frame with an opaque origin and no network,
 * so its scripts work but cannot act as the viewer.
 */
export const HtmlPage = meta.story({
	args: { onClose: fn() },
	render: ({ onClose }) => (
		<ArtifactStageView
			pod={revenue}
			artifact={atVersion(dashboard, 1, pageContent)}
			versions={[{ number: 1, author: null, createdAt: dashboard.createdAt }]}
			now={now}
			onVersionChange={fn()}
			onClose={onClose}
		/>
	),
	play: async ({ args, canvas, userEvent }) => {
		const frame = canvas.getByTitle("Pipeline by stage");
		await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
		await expect(frame.getAttribute("srcdoc")).toContain(FRAME_CONTENT_POLICY);
		// An opaque origin: the app cannot reach into the frame, nor the frame out to the app.
		await expect((frame as HTMLIFrameElement).contentDocument).toBeNull();
		await userEvent.click(canvas.getByRole("button", { name: "Close" }));
		await expect(args.onClose).toHaveBeenCalled();
	},
});

/** On a phone the opened artifact takes the whole screen. */
export const DocumentOnAPhone = meta.story({
	...Document.input,
	globals: { viewport: { value: "mobile1" } },
});

const written = (tool: string, artifact: ArtifactSummary): ToolCallPart => ({
	type: "tool_call",
	id: `0199a3a0-0000-7000-8000-0000000003${artifact.id.slice(-2)}`,
	tool,
	input: {},
	output: {
		status: "written",
		artifactId: artifact.id,
		kind: artifact.kind,
		title: artifact.title,
		version: artifact.version,
	},
	status: "completed",
	error: null,
	mutating: true,
	atOffset: 0,
	startedAt: "2026-10-01T08:10:00.000Z",
	finishedAt: "2026-10-01T08:10:01.000Z",
});

/**
 * Under a bot's tool line, an artifact its reply wrote, read from the call's
 * result and fetched at that version: only its name until it is expanded.
 */
export const InAThread = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${import.meta.env.VITE_API_URL}/pods/:podId/artifacts/:artifactId/versions/3`, () =>
				HttpResponse.json(atVersion(plan, 3, planContent)),
			),
		);
	},
	render: () => (
		<QueryPreview>
			<div className="p-6 pl-[50px]">
				<ArtifactCards
					calls={[written("artifact_edit", plan)]}
					podId={revenue.id}
					botName={scribe.name}
					onOpen={fn()}
				/>
			</div>
		</QueryPreview>
	),
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByText("Document by Growth Desk")).toBeVisible();
		await expect(canvas.queryByRole("heading", { name: "Goals" })).toBeNull();
		await userEvent.click(canvas.getByRole("button", { name: "Preview Q4 outreach plan" }));
		await expect(await canvas.findByRole("heading", { name: "Goals" })).toBeVisible();
	},
});

function QueryPreview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const asWritten = (summary: ArtifactSummary, title = summary.title): WrittenArtifact => ({
	artifactId: summary.id,
	kind: summary.kind,
	title,
	version: summary.version,
});

/**
 * A document's card expands to show its start, and opens it large from its
 * Open, or from anywhere on what it shows.
 */
export const InlineDocument = meta.story({
	args: { onOpen: fn() },
	render: ({ onOpen }) => (
		<div className="w-full max-w-[620px] p-6 pl-[50px]">
			<ArtifactCardView
				artifact={asWritten(plan)}
				botName={scribe.name}
				content={planContent}
				onOpen={onOpen}
			/>
		</div>
	),
	play: async ({ args, canvas, userEvent }) => {
		const preview = canvas.getByRole("button", { name: "Preview Q4 outreach plan" });
		await expect(preview).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(preview);
		await expect(preview).toHaveAttribute("aria-expanded", "true");
		await expect(canvas.getByRole("heading", { name: "Goals" })).toBeVisible();
		const opens = canvas.getAllByRole("button", { name: "Open Q4 outreach plan" });
		await userEvent.click(opens[0] as HTMLElement);
		await expect(args.onOpen).toHaveBeenCalled();
	},
});

/** A card whose artifact has been deleted keeps only its name, marked deleted, with nothing to open. */
export const InlineDeleted = meta.story({
	render: () => (
		<div className="w-full max-w-[620px] p-6 pl-[50px]">
			<ArtifactCardView
				artifact={asWritten(dashboard)}
				botName={scribe.name}
				content="deleted"
				onOpen={fn()}
			/>
		</div>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Page by Growth Desk, deleted")).toBeVisible();
		await expect(canvas.queryByRole("button")).toBeNull();
	},
});

/** A card whose artifact could not be loaded still says what it is and opens it, with nothing to expand. */
export const InlineFailed = meta.story({
	render: () => (
		<div className="w-full max-w-[620px] p-6 pl-[50px]">
			<ArtifactCardView
				artifact={asWritten(plan)}
				botName={scribe.name}
				content="failed"
				onOpen={fn()}
			/>
		</div>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "Open Q4 outreach plan" })).toBeVisible();
		await expect(canvas.queryByRole("button", { name: "Preview Q4 outreach plan" })).toBeNull();
	},
});

/** An interactive chart drawn by the page itself in the app's tokens: bars that show their value under the pointer. */
const chartPage = `<!doctype html>
<html><head><style>
body { padding: 16px; font-size: 13px; }
h1 { font-size: 15px; margin: 0 0 12px; color: var(--foreground); }
.bar { fill: var(--primary); } .bar:hover { fill: var(--link); } text { fill: var(--muted-foreground); }
#value { height: 18px; color: var(--muted-foreground); }
</style></head><body>
<h1>Pipeline by stage</h1>
<svg id="chart" width="100%" viewBox="0 0 400 180" role="img" aria-label="Pipeline by stage"></svg>
<p id="value">Point at a bar</p>
<script>
const stages = [["Lead", 120], ["Qualified", 84], ["Proposal", 41], ["Won", 18]];
const chart = document.getElementById("chart");
stages.forEach(([name, deals], index) => {
	const height = deals * 1.2;
	const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
	Object.entries({ class: "bar", x: 20 + index * 95, y: 160 - height, width: 70, height }).forEach(([key, value]) => bar.setAttribute(key, value));
	bar.addEventListener("mouseenter", () => { document.getElementById("value").textContent = name + ": " + deals + " deals"; });
	chart.append(bar);
	const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
	Object.entries({ x: 55 + index * 95, y: 176, "text-anchor": "middle", "font-size": 12 }).forEach(([key, value]) => label.setAttribute(key, value));
	label.textContent = name;
	chart.append(label);
});
</script>
</body></html>`;

/** A page a reply wrote, running in place under a header that says which bot made it. */
export const InlinePage = meta.story({
	render: () => (
		<div className="w-full max-w-[620px] p-6 pl-[50px]">
			<ArtifactCardView
				artifact={asWritten(dashboard)}
				botName={scribe.name}
				content={chartPage}
				onOpen={fn()}
			/>
		</div>
	),
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByText("Page by Growth Desk")).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Preview Pipeline by stage" }));
		await expect(canvas.getByTitle("Pipeline by stage").getAttribute("srcdoc")).toContain(
			"--primary:",
		);
		await expect(canvas.getByRole("button", { name: "Open Pipeline by stage" })).toBeVisible();
		await expect(canvas.getByTitle("Pipeline by stage")).toBeVisible();
	},
});

/** Loading the page a reply wrote. */
export const InlinePageLoading = meta.story({
	render: () => (
		<div className="w-full max-w-[620px] p-6 pl-[50px]">
			<ArtifactCardView
				artifact={asWritten(dashboard)}
				botName={scribe.name}
				content={undefined}
				onOpen={fn()}
			/>
		</div>
	),
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Preview Pipeline by stage" }));
		await expect(canvas.getByText("Loading…")).toBeVisible();
	},
});

const tallPage = `<!doctype html><html><body style="padding: 16px">${Array.from(
	{ length: 60 },
	(_, row) => `<p style="margin: 0 0 12px">Row ${row + 1}</p>`,
).join("")}</body></html>`;

/** A page taller than the frame: clipped, shown all, then clipped again. */
export const InlinePageTall = meta.story({
	render: () => (
		<div className="w-full max-w-[620px] p-6 pl-[50px]">
			<ArtifactCardView
				artifact={asWritten(dashboard, "Every deal")}
				botName={scribe.name}
				content={tallPage}
				onOpen={fn()}
			/>
		</div>
	),
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Preview Every deal" }));
		await userEvent.click(await canvas.findByRole("button", { name: "Show all" }));
		await userEvent.click(await canvas.findByRole("button", { name: "Show less" }));
		await expect(await canvas.findByRole("button", { name: "Show all" })).toBeVisible();
	},
});

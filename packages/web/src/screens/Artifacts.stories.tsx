import type {
	Artifact,
	ArtifactSummary,
	ArtifactVersionSummary,
	ToolCallPart,
} from "@sugabots/contracts";
import { expect, fn, screen } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.ts";
import { ArtifactCards, InlinePageView } from "./ArtifactCards.tsx";
import { ArtifactListView, ArtifactView } from "./Artifacts.tsx";
import { FRAME_CONTENT_POLICY } from "./HtmlFrame.tsx";

const now = new Date("2026-10-01T09:30:00.000Z");
const scribe = { agentId: "0199a3a0-0000-7000-8000-0000000000a1", name: "Growth Desk" };

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

/** A pod's artifacts, newest first, each with its kind, who made it and its version. */
export const List = meta.story({
	render: () => <ArtifactListView pod={revenue} artifacts={[plan, dashboard]} now={now} />,
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /Q4 outreach plan/ })).toBeVisible();
		await expect(canvas.getByText(/Page · by a removed bot · version 1/)).toBeVisible();
	},
});

/** Before any bot has made one, the page says how one gets here. */
export const Empty = meta.story({
	render: () => <ArtifactListView pod={revenue} artifacts={[]} now={now} />,
	play: async ({ canvas }) => {
		await expect(canvas.getByText(`No artifacts in ${revenue.name} yet`)).toBeVisible();
	},
});

/** A document at its current version, drawn as markdown. */
export const Document = meta.story({
	render: () => (
		<ArtifactView
			pod={revenue}
			artifact={atVersion(plan, 3, planContent)}
			versions={versions}
			now={now}
		/>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("heading", { name: "Risks" })).toBeVisible();
		await expect(canvas.getByRole("button", { name: /Version 3 · by Growth Desk/ })).toBeVisible();
	},
});

/** An earlier version says which of how many it is, and the menu lists the rest. */
export const EarlierVersion = meta.story({
	render: () => (
		<ArtifactView
			pod={revenue}
			artifact={atVersion(plan, 1, "# Q4 outreach plan\n\n## Goals\n\nTo be decided.\n")}
			versions={versions}
			now={now}
		/>
	),
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Version 1 of 3/ }));
		await expect(await screen.findByRole("menuitem", { name: /Version 3/ })).toBeVisible();
	},
});

/**
 * An HTML page runs in a sandboxed frame with an opaque origin and no network,
 * so its scripts work but cannot act as the viewer.
 */
export const HtmlPage = meta.story({
	render: () => (
		<ArtifactView
			pod={revenue}
			artifact={atVersion(dashboard, 1, pageContent)}
			versions={[{ number: 1, author: null, createdAt: dashboard.createdAt }]}
			now={now}
		/>
	),
	play: async ({ canvas }) => {
		const frame = canvas.getByTitle("Pipeline by stage");
		await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
		await expect(frame.getAttribute("srcdoc")).toContain(FRAME_CONTENT_POLICY);
		// An opaque origin: the app cannot reach into the frame, nor the frame out to the app.
		await expect((frame as HTMLIFrameElement).contentDocument).toBeNull();
	},
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

/** Under a bot's tool line, a document its reply wrote, one click from the conversation. */
export const InAThread = meta.story({
	render: () => (
		<div className="p-6 pl-[50px]">
			<ArtifactCards
				calls={[written("document_replace_section", plan)]}
				podId={revenue.id}
				botName={scribe.name}
				onOpen={fn()}
			/>
		</div>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: /Q4 outreach plan/ })).toBeVisible();
		await expect(canvas.getByText("Document · version 3")).toBeVisible();
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

/** A page a reply wrote, shown in place in a frame that says which bot made it. */
export const InlinePage = meta.story({
	render: () => {
		const output = written("artifact_create", dashboard).output as Record<string, unknown>;
		return (
			<div className="max-w-[720px] p-6 pl-[50px]">
				<InlinePageView
					artifact={{
						artifactId: String(output.artifactId),
						kind: "html",
						title: dashboard.title,
						version: dashboard.version,
					}}
					botName={scribe.name}
					html={chartPage}
					onOpen={fn()}
				/>
			</div>
		);
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByText(/page made by Growth Desk/)).toBeVisible();
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
		<div className="max-w-[720px] p-6 pl-[50px]">
			<InlinePageView
				artifact={{
					artifactId: dashboard.id,
					kind: "html",
					title: dashboard.title,
					version: dashboard.version,
				}}
				botName={scribe.name}
				html={undefined}
				onOpen={fn()}
			/>
		</div>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Loading page…")).toBeVisible();
	},
});

const tallPage = `<!doctype html><html><body style="padding: 16px">${Array.from(
	{ length: 60 },
	(_, row) => `<p style="margin: 0 0 12px">Row ${row + 1}</p>`,
).join("")}</body></html>`;

/** A page taller than the frame: clipped, shown all, then clipped again. */
export const InlinePageTall = meta.story({
	render: () => (
		<div className="max-w-[720px] p-6 pl-[50px]">
			<InlinePageView
				artifact={{
					artifactId: dashboard.id,
					kind: "html",
					title: "Every deal",
					version: 1,
				}}
				botName={scribe.name}
				html={tallPage}
				onOpen={fn()}
			/>
		</div>
	),
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Show all" }));
		await userEvent.click(await canvas.findByRole("button", { name: "Show less" }));
		await expect(await canvas.findByRole("button", { name: "Show all" })).toBeVisible();
	},
});

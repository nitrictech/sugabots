import type {
	Artifact,
	ArtifactSummary,
	ArtifactVersionSummary,
	ToolCallPart,
} from "@sugabots/contracts";
import { expect, fn, screen } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.ts";
import { ArtifactCards } from "./ArtifactCards.tsx";
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

/** Under a bot's tool line, what its reply wrote, one click from the conversation. */
export const InAThread = meta.story({
	render: () => {
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
		return (
			<div className="p-6 pl-[50px]">
				<ArtifactCards
					calls={[written("document_replace_section", plan), written("artifact_create", dashboard)]}
					onOpen={fn()}
				/>
			</div>
		);
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: /Pipeline by stage/ })).toBeVisible();
		await expect(canvas.getByText("Document · version 3")).toBeVisible();
	},
});

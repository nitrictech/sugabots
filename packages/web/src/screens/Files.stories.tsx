import type {
	ListedFileVersion,
	ListedMessageFile,
	ListedWrittenFile,
	ToolCallPart,
	WrittenFile,
} from "@sugabots/contracts";
import { PAGE_CONTENT_POLICY } from "@sugabots/contracts/file-pages";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect, fn, screen, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers } from "@/story-app.test-support.tsx";
import { type FileAsWritten, FileCards, FileCardView } from "./FileCards.tsx";
import { FileListView, FileStageView } from "./Files.tsx";
import { PagesFromContentOrigin } from "./HtmlFrame.tsx";

const now = new Date("2026-10-01T09:30:00.000Z");
const writer = { botId: growthDesk.id, name: growthDesk.name };

const plan: ListedWrittenFile = {
	id: "0199a3a0-0000-7000-8000-0000000000f1",
	chatId: "0199a3a0-0000-7000-8000-0000000000e1",
	kind: "markdown",
	title: "Q4 outreach plan",
	version: 3,
	createdBy: writer,
	createdAt: "2026-09-29T07:00:00.000Z",
	updatedAt: "2026-10-01T08:10:00.000Z",
};

const dashboard: ListedWrittenFile = {
	id: "0199a3a0-0000-7000-8000-0000000000f2",
	chatId: "0199a3a0-0000-7000-8000-0000000000e1",
	kind: "html",
	title: "Pipeline by stage",
	version: 1,
	createdBy: null,
	createdAt: "2026-09-24T12:00:00.000Z",
	updatedAt: "2026-09-24T12:00:00.000Z",
};

const brief: ListedMessageFile = {
	id: "0199a3a0-0000-7000-8000-0000000000f3",
	chatId: "0199a3a0-0000-7000-8000-0000000000e1",
	kind: "attachment",
	name: "Account list.csv",
	contentType: "text/csv",
	size: 48_200,
	author: "Kim Lee",
	createdAt: "2026-10-01T07:55:00.000Z",
	updatedAt: "2026-10-01T08:00:00.000Z",
};

const versions: ListedFileVersion[] = [
	{ number: 3, author: writer, createdAt: "2026-10-01T08:10:00.000Z" },
	{ number: 2, author: writer, createdAt: "2026-09-30T15:00:00.000Z" },
	{ number: 1, author: writer, createdAt: "2026-09-29T07:00:00.000Z" },
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

const atVersion = (summary: ListedWrittenFile, number: number, content: string): WrittenFile => ({
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
	title: "Views/Files",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	// The workspace's answers, for the counts and lists around the files.
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
	decorators: [
		(Story) => (
			<QueryPreview>
				<div className="flex h-160 min-w-0">
					<Story />
				</div>
			</QueryPreview>
		),
	],
});

/**
 * A project's files, newest first under when each was last updated. One a bot
 * wrote shows its kind, version and who made it, and opens beside the list;
 * one sent on a message shows its size and who sent it, and opens on its own.
 */
export const List = meta.story({
	render: () => (
		<FileListView owner={{ project: revenue }} files={[plan, brief, dashboard]} now={now} />
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /Q4 outreach plan/ })).toHaveAttribute(
			"href",
			expect.stringContaining(`/files/${plan.id}`),
		);
		await expect(canvas.getByRole("link", { name: /Q4 outreach plan/ })).toHaveTextContent(
			"Document, v3, Growth Desk",
		);
		const sent = canvas.getByRole("link", { name: /Account list\.csv/ });
		await expect(sent).toHaveTextContent("47 KB, Kim Lee");
		await expect(sent).toHaveAttribute(
			"href",
			expect.stringContaining(`/chats/${brief.chatId}/files/${brief.id}`),
		);
		const earlier = canvas.getByRole("region", { name: "Earlier this week" });
		await expect(within(earlier).getByText(/A removed bot$/)).toBeVisible();
		await expect(canvas.getByRole("region", { name: "Today" })).toBeVisible();
	},
});

/** One open beside the list, its row marked. */
export const ListWithOneOpen = meta.story({
	render: () => (
		<FileListView
			owner={{ project: revenue }}
			files={[plan, dashboard]}
			selectedId={plan.id}
			now={now}
		>
			<FileStageView
				owner={{ project: revenue }}
				file={atVersion(plan, 3, planContent)}
				versions={versions}
				now={now}
				onVersionChange={fn()}
				onClose={fn()}
			/>
		</FileListView>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: /Q4 outreach plan/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("heading", { name: "Risks" })).toBeVisible();
	},
});

/** Before any bot has made one, the page says how one gets here. */
export const Empty = meta.story({
	render: () => <FileListView owner={{ project: revenue }} files={[]} now={now} />,
	play: async ({ canvas }) => {
		await expect(canvas.getByText(`No files from ${revenue.name} yet`)).toBeVisible();
	},
});

/** A document opened large at its current version, drawn as markdown, with who wrote it and when. */
export const Document = meta.story({
	render: () => (
		<FileStageView
			owner={{ project: revenue }}
			file={atVersion(plan, 3, planContent)}
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
		await waitFor(() => expect(screen.getByRole("menuitem", { name: "Download" })).toBeVisible());
		await expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
		await expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
		await userEvent.keyboard("{Escape}");
		// The accessibility check after the story would otherwise catch the
		// menu's focus guards while it is still closing.
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	},
});

/** Those who manage the project can delete a file from its menu, once they confirm it. */
export const Delete = meta.story({
	args: { onDelete: fn() },
	render: ({ onDelete }) => (
		<FileStageView
			owner={{ project: revenue }}
			file={atVersion(plan, 3, planContent)}
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
		<FileStageView
			owner={{ project: revenue }}
			file={atVersion(plan, 1, "# Q4 outreach plan\n\n## Goals\n\nTo be decided.\n")}
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
		<FileStageView
			owner={{ project: revenue }}
			file={atVersion(dashboard, 1, pageContent)}
			versions={[{ number: 1, author: null, createdAt: dashboard.createdAt }]}
			now={now}
			onVersionChange={fn()}
			onClose={onClose}
		/>
	),
	play: async ({ args, canvas, userEvent }) => {
		const frame = canvas.getByTitle("Pipeline by stage");
		await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
		await expect(frame.getAttribute("srcdoc")).toContain(PAGE_CONTENT_POLICY);
		// An opaque origin: the app cannot reach into the frame, nor the frame out to the app.
		await expect((frame as HTMLIFrameElement).contentDocument).toBeNull();
		await userEvent.click(canvas.getByRole("button", { name: "Close" }));
		await expect(args.onClose).toHaveBeenCalled();
	},
});

/** On a phone the opened file takes the whole screen. */
export const DocumentOnAPhone = meta.story({
	...Document.input,
	globals: { viewport: { value: "mobile1" } },
});

const written = (tool: string, file: ListedWrittenFile): ToolCallPart => ({
	type: "tool_call",
	id: `0199a3a0-0000-7000-8000-0000000003${file.id.slice(-2)}`,
	tool,
	input: {},
	output: {
		status: "written",
		fileId: file.id,
		kind: file.kind,
		title: file.title,
		version: file.version,
	},
	status: "completed",
	error: null,
	approval: null,
	atOffset: 0,
	startedAt: "2026-10-01T08:10:00.000Z",
	finishedAt: "2026-10-01T08:10:01.000Z",
});

/**
 * Under a bot's tool line, a file its reply wrote, read from the call's
 * result and fetched at that version: its start over the line naming it.
 */
export const InAChat = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(`${import.meta.env.VITE_API_URL}/files/:fileId/versions/3`, () =>
				HttpResponse.json(atVersion(plan, 3, planContent)),
			),
		);
	},
	render: () => (
		<QueryPreview>
			<div className="p-6 pl-12.5">
				<FileCards parts={[written("file_edit", plan)]} botName={writer.name} onOpen={fn()} />
			</div>
		</QueryPreview>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Document by Growth Desk")).toBeVisible();
		await expect(await canvas.findByRole("heading", { name: "Goals" })).toBeVisible();
	},
});

/** On a phone, the card fits the screen, with who made it whole on its line. */
export const InAChatOnAPhone = meta.story({
	beforeEach: InAChat.input.beforeEach,
	render: InAChat.input.render,
	globals: { viewport: { value: "mobile1" } },
	play: async ({ canvas }) => {
		const maker = canvas.getByText("Document by Growth Desk");
		const card = canvas.getByRole("article", { name: "Q4 outreach plan" });
		await expect(maker.scrollWidth).toBeLessThanOrEqual(maker.clientWidth);
		await expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
	},
});

function QueryPreview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const asWritten = (summary: ListedWrittenFile, title = summary.title): FileAsWritten => ({
	fileId: summary.id,
	kind: summary.kind,
	title,
	version: summary.version,
});

/**
 * A document's card shows its start, and opens it large from its line, or
 * from anywhere on what it shows; Download saves it.
 */
export const InlineDocument = meta.story({
	args: { onOpen: fn() },
	render: ({ onOpen }) => (
		<div className="w-full max-w-155 p-6 pl-12.5">
			<FileCardView
				file={asWritten(plan)}
				botName={writer.name}
				content={planContent}
				onOpen={onOpen}
			/>
		</div>
	),
	play: async ({ args, canvas, userEvent }) => {
		const goals = canvas.getByRole("heading", { name: "Goals" });
		await expect(goals).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Open Q4 outreach plan" }));
		await expect(args.onOpen).toHaveBeenCalledTimes(1);
		await userEvent.click(goals);
		await expect(args.onOpen).toHaveBeenCalledTimes(2);
		await expect(canvas.getByRole("button", { name: "Download Q4 outreach plan" })).toBeVisible();
	},
});

/** A card whose file has been deleted keeps only its name, marked deleted, with nothing to open. */
export const InlineDeleted = meta.story({
	render: () => (
		<div className="w-full max-w-155 p-6 pl-12.5">
			<FileCardView
				file={asWritten(dashboard)}
				botName={writer.name}
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

/** A card whose file could not be loaded still says what it is and opens it, with nothing to preview or download. */
export const InlineFailed = meta.story({
	render: () => (
		<div className="w-full max-w-155 p-6 pl-12.5">
			<FileCardView file={asWritten(plan)} botName={writer.name} content="failed" onOpen={fn()} />
		</div>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "Open Q4 outreach plan" })).toBeVisible();
		await expect(canvas.queryByRole("heading", { name: "Goals" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Download Q4 outreach plan" })).toBeNull();
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

/** A page a reply wrote, running in place over the line that says which bot made it. */
export const InlinePage = meta.story({
	render: () => (
		<div className="w-full max-w-155 p-6 pl-12.5">
			<FileCardView
				file={asWritten(dashboard)}
				botName={writer.name}
				content={chartPage}
				onOpen={fn()}
			/>
		</div>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Page by Growth Desk")).toBeVisible();
		await expect(canvas.getByTitle("Pipeline by stage").getAttribute("srcdoc")).toContain(
			"--primary:",
		);
		await expect(canvas.getByRole("button", { name: "Open Pipeline by stage" })).toBeVisible();
		await expect(canvas.getByTitle("Pipeline by stage")).toBeVisible();
	},
});

/** A page from a GitHub run stays off until the member loads it. */
export const PageFromGitHubRun = meta.story({
	render: () => (
		<FileCardView
			file={asWritten(dashboard)}
			botName={writer.name}
			content={chartPage}
			outsideRun="github"
			onOpen={fn()}
		/>
	),
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByText("Written by a run started by a GitHub event.")).toBeVisible();
		await expect(canvas.queryByTitle(dashboard.title)).not.toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: `Load page ${dashboard.title}` }));
		await expect(canvas.getByTitle(dashboard.title)).toBeVisible();
	},
});

/** Loading the page a reply wrote. */
export const InlinePageLoading = meta.story({
	render: () => (
		<div className="w-full max-w-155 p-6 pl-12.5">
			<FileCardView
				file={asWritten(dashboard)}
				botName={writer.name}
				content={undefined}
				onOpen={fn()}
			/>
		</div>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Loading…")).toBeVisible();
	},
});

const tallPage = `<!doctype html><html><body style="padding: 16px">${Array.from(
	{ length: 60 },
	(_, row) => `<p style="margin: 0 0 12px">Row ${row + 1}</p>`,
).join("")}</body></html>`;

/** A page taller than its preview: cut off and faded, and opened large to be seen whole. */
export const InlinePageTall = meta.story({
	args: { onOpen: fn() },
	render: ({ onOpen }) => (
		<div className="w-full max-w-155 p-6 pl-12.5">
			<FileCardView
				file={asWritten(dashboard, "Every deal")}
				botName={writer.name}
				content={tallPage}
				onOpen={onOpen}
			/>
		</div>
	),
	play: async ({ args, canvas, userEvent }) => {
		const frame = await canvas.findByTitle("Every deal");
		await waitFor(() => expect(frame.getBoundingClientRect().height).toBeGreaterThan(400));
		await expect(
			canvas.getByRole("article", { name: "Every deal" }).getBoundingClientRect().height,
		).toBeLessThan(300);
		await userEvent.click(canvas.getByRole("button", { name: "Open Every deal" }));
		await expect(args.onOpen).toHaveBeenCalled();
	},
});

const pageAddress = (url: string | null) =>
	http.get(`${import.meta.env.VITE_API_URL}/files/:fileId/versions/:version/page`, () =>
		HttpResponse.json({ url }),
	);

/** In the app, with pages on the content origin. */
function ContentOriginPreview({ children }: { children: ReactNode }) {
	return (
		<QueryPreview>
			<PagesFromContentOrigin value={true}>{children}</PagesFromContentOrigin>
		</QueryPreview>
	);
}

/**
 * With a content origin set, the page loads from the address the API gives
 * out, the app's theme in its fragment, with the frame asking for the page's
 * policy so Chromium refuses any other site in it.
 */
export const PageFromContentOrigin = meta.story({
	beforeEach({ msw }) {
		msw.use(pageAddress("https://pages.example-content.com/pages/sealed"));
	},
	render: () => (
		<ContentOriginPreview>
			<div className="w-full max-w-155 p-6 pl-12.5">
				<FileCardView
					file={asWritten(dashboard)}
					botName={writer.name}
					content={chartPage}
					onOpen={fn()}
				/>
			</div>
		</ContentOriginPreview>
	),
	play: async ({ canvas }) => {
		const frame = await canvas.findByTitle("Pipeline by stage");
		await waitFor(() =>
			expect(frame.getAttribute("src")).toMatch(
				/^https:\/\/pages\.example-content\.com\/pages\/sealed#%7B%22colorScheme%22/,
			),
		);
		await expect(frame).toHaveAttribute("csp", PAGE_CONTENT_POLICY);
		await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
		await expect(frame).not.toHaveAttribute("srcdoc");
	},
});

/** Without a content origin, the page is written into its frame as before. */
export const PageWithoutContentOrigin = meta.story({
	beforeEach({ msw }) {
		msw.use(pageAddress(null));
	},
	render: PageFromContentOrigin.input.render,
	play: async ({ canvas }) => {
		const frame = await canvas.findByTitle("Pipeline by stage");
		await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain(PAGE_CONTENT_POLICY));
		await expect(frame).not.toHaveAttribute("src");
	},
});

/**
 * When the address can't be had, the card says so and offers to ask again,
 * rather than leaving a blank space or writing the page into its frame.
 */
export const PageAddressFailed = meta.story({
	beforeEach({ msw }) {
		let asked = 0;
		msw.use(
			http.get(`${import.meta.env.VITE_API_URL}/files/:fileId/versions/:version/page`, () => {
				asked += 1;
				return asked === 1
					? HttpResponse.json({ message: "unavailable" }, { status: 503 })
					: HttpResponse.json({ url: "https://pages.example-content.com/pages/sealed" });
			}),
		);
	},
	render: PageFromContentOrigin.input.render,
	play: async ({ canvas, userEvent }) => {
		await expect(await canvas.findByRole("alert")).toHaveTextContent(
			"This page couldn't be loaded.",
		);
		await expect(canvas.queryByTitle("Pipeline by stage")).toBeNull();

		await userEvent.click(canvas.getByRole("button", { name: "Try again" }));

		const frame = await canvas.findByTitle("Pipeline by stage");
		await expect(frame.getAttribute("src")).toMatch(/^https:\/\/pages\.example-content\.com\//);
	},
});

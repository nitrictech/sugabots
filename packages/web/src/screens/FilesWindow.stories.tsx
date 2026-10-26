import { ws } from "msw";
import { useRef } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import type { Placement } from "./DesktopWindow.tsx";
import { FilesWindow, type FolderEntry } from "./FilesWindow.tsx";

const threadId = "0199a3a0-0000-7000-8000-000000000601";
const agentId = "0199a3a0-0000-7000-8000-000000000602";
const filesChannel = ws.link(
	`${(import.meta.env.VITE_API_URL as string).replace(/^http/, "ws")}/threads/${threadId}/agents/${agentId}/desktop/files`,
);
const THREAD_FOLDER = "/workspace/threads/t1";
const MODIFIED = "2026-10-20T09:00:00.000Z";
const file = (name: string, size: number): FolderEntry => ({
	name,
	kind: "file",
	size,
	modified: MODIFIED,
});
const folder = (name: string): FolderEntry => ({
	name,
	kind: "folder",
	size: 4096,
	modified: MODIFIED,
});

/** The sandbox's folders, as a desktop server would list them. */
const FOLDERS: Record<string, FolderEntry[]> = {
	[THREAD_FOLDER]: [
		file("report.md", 2048),
		folder("site"),
		file("chart-2.png", 48_213),
		file("chart-10.png", 51_002),
		file("data.csv", 913_408),
		file(".env", 120),
	],
	[`${THREAD_FOLDER}/site`]: [file("index.html", 1312), file("styles.css", 840)],
	"/workspace": [folder("threads")],
	"/workspace/threads": [folder("t1")],
	"/home/agent": [file(".bashrc", 3526), folder("notes")],
	"/": [folder("home"), folder("workspace"), folder("usr")],
};
const GIGABYTE = 1024 ** 3;
const DISK = { freeBytes: 12.4 * GIGABYTE, totalBytes: 50 * GIGABYTE };
const REPORT = "# Pricing review\n\nThe three plans, compared.\n";
const sentToFiles = fn();

/**
 * A desktop server's files channel over `FOLDERS`, answering a viewer in
 * control, or refusing one who only watches, as the sandbox does. Uploads
 * are acknowledged and land in the folder they were put in.
 */
const filesServer = ({ inControl }: { inControl: boolean }) =>
	filesChannel.addEventListener("connection", ({ client }) => {
		const folders = structuredClone(FOLDERS);
		const send = (message: object) => client.send(JSON.stringify(message));
		const uploads = new Map<string, { folder: string; name: string; size: number; got: number }>();
		const sendPlaces = () =>
			send({
				type: "places",
				places: [
					{ kind: "thread", path: THREAD_FOLDER },
					{ kind: "workspace", path: "/workspace" },
					{ kind: "home", path: "/home/agent" },
					{ kind: "computer", path: "/" },
				],
			});
		client.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			sentToFiles(message.type === "upload-chunk" ? { ...message, data: "…" } : message);
			const path = message.path === "." ? THREAD_FOLDER : message.path;
			if (!inControl) {
				return send({ type: "refused", path, reason: "Take over to browse the files." });
			}
			if (message.type === "places") return sendPlaces();
			if (message.type === "list") {
				return send({ type: "listing", path, entries: folders[path] ?? [], disk: DISK });
			}
			if (message.type === "read") {
				const data = btoa(REPORT);
				return send({ type: "file", path, mediaType: "text/plain", data, truncated: false });
			}
			if (message.type === "upload") {
				const into = message.folder;
				uploads.set(message.id, { folder: into, name: message.name, size: message.size, got: 0 });
				return send({ type: "upload-received", id: message.id, bytes: 0 });
			}
			if (message.type === "upload-chunk") {
				const upload = uploads.get(message.id);
				if (!upload) return;
				upload.got += atob(message.data).length;
				if (upload.got < upload.size) {
					return send({ type: "upload-received", id: message.id, bytes: upload.got });
				}
				folders[upload.folder] = [
					...(folders[upload.folder] ?? []),
					file(upload.name, upload.size),
				];
				send({ type: "uploaded", id: message.id, path: `${upload.folder}/${upload.name}` });
				send({ type: "listing", path: upload.folder, entries: folders[upload.folder], disk: DISK });
			}
		});
	});

function FilesOnADesktop({ viewOnly }: { viewOnly: boolean }) {
	const surface = useRef<HTMLDivElement>(null);
	const placement: Placement = {
		x: 0,
		y: 0,
		width: 0,
		height: 0,
		order: 1,
		minimized: false,
		maximized: true,
	};
	return (
		<div ref={surface} className="relative h-[520px] overflow-hidden rounded-xl bg-rail">
			<FilesWindow
				threadId={threadId}
				agentId={agentId}
				viewOnly={viewOnly}
				placement={placement}
				front
				surface={surface}
				onFocus={() => {}}
				onPlace={() => {}}
				onMinimize={() => {}}
				onClose={() => {}}
			/>
		</div>
	);
}

const meta = preview.meta({
	title: "Product/FilesWindow",
	component: FilesOnADesktop,
	tags: ["ai-generated"],
	args: { viewOnly: false },
	beforeEach({ msw, args }) {
		sentToFiles.mockClear();
		msw.use(filesServer({ inControl: !args.viewOnly }));
	},
});

/**
 * The thread's folder, as a person in control first sees it: places down
 * the side, the path along the top, and folders before files, numbered names
 * in counting order and hidden files left out.
 */
export const Browsing = meta.story({
	play: async ({ canvas }) => {
		const contents = await canvas.findByRole("list", { name: "Folder contents" });
		const names = within(contents)
			.getAllByRole("button")
			.map((entry) => entry.dataset.entry);
		await expect(names).toEqual(["site", "chart-2.png", "chart-10.png", "data.csv", "report.md"]);
		const places = canvas.getByRole("navigation", { name: "Places" });
		await expect(within(places).getByRole("button", { name: "This thread" })).toHaveAttribute(
			"aria-current",
			"location",
		);
		const path = canvas.getByRole("navigation", { name: "Path" });
		await expect(within(path).getByRole("button", { name: "t1" })).toHaveAttribute(
			"aria-current",
			"location",
		);
		await expect(within(places).getByText("12.4 GB free of 50.0 GB")).toBeVisible();
	},
});

/**
 * Opening a folder with a double click and a file with Enter, then going
 * back to where the person was, and forward again.
 */
export const OpeningAndGoingBack = meta.story({
	play: async ({ canvas, userEvent }) => {
		const contents = await canvas.findByRole("list", { name: "Folder contents" });
		await userEvent.dblClick(within(contents).getByRole("button", { name: /^site/ }));
		await expect(await canvas.findByRole("button", { name: /^index\.html/ })).toBeVisible();

		await userEvent.click(canvas.getByRole("button", { name: "Back" }));
		const report = await canvas.findByRole("button", { name: /^report\.md/ });
		await userEvent.click(report);
		await expect(canvas.getByText("“report.md” selected (2.0 KB)")).toBeVisible();
		await userEvent.keyboard("{Enter}");
		await expect(await canvas.findByText(/The three plans, compared\./)).toBeVisible();

		await userEvent.click(canvas.getByRole("button", { name: "Back" }));
		await expect(await canvas.findByRole("button", { name: /^report\.md/ })).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Forward" }));
		await expect(await canvas.findByText(/The three plans, compared\./)).toBeVisible();
	},
});

/** Home from the sidebar, with its hidden files shown and the folder as icons. */
export const HomeAsIcons = meta.story({
	play: async ({ canvas, userEvent }) => {
		const places = await canvas.findByRole("navigation", { name: "Places" });
		await userEvent.click(await within(places).findByRole("button", { name: "Home" }));
		await userEvent.click(canvas.getByRole("button", { name: "Show hidden files" }));
		await userEvent.click(canvas.getByRole("button", { name: "Show as icons" }));
		await expect(await canvas.findByRole("button", { name: ".bashrc" })).toBeVisible();
		const path = canvas.getByRole("navigation", { name: "Path" });
		await expect(within(path).getByRole("button", { name: "Home" })).toHaveAttribute(
			"aria-current",
			"location",
		);
	},
});

/**
 * Files picked with Upload, sent in pieces and put in the folder shown,
 * where they appear.
 */
export const Uploading = meta.story({
	play: async ({ canvas, userEvent }) => {
		await canvas.findByRole("list", { name: "Folder contents" });
		const notes = new File(["Call the vendor back."], "notes.txt", { type: "text/plain" });
		await userEvent.upload(canvas.getByLabelText("Files to upload"), notes);
		await expect(await canvas.findByRole("button", { name: /^notes\.txt/ })).toBeVisible();
		await waitFor(() =>
			expect(sentToFiles).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "upload",
					folder: THREAD_FOLDER,
					name: "notes.txt",
					size: notes.size,
				}),
			),
		);
	},
});

/** Someone only watching is told to take over; uploading waits for them to. */
export const Watching = meta.story({
	args: { viewOnly: true },
	play: async ({ canvas }) => {
		await expect(await canvas.findByText("Take over to browse the files.")).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Upload files" })).toBeDisabled();
		await expect(canvas.queryByRole("navigation", { name: "Places" })).toBeNull();
	},
});

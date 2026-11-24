import { type ChildProcess, fork } from "node:child_process";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { TooltipProvider } from "@/ui/tooltip.tsx";
import { LiveDocument, type WordImport } from "./LiveDocument.tsx";
import { LINKED_IMAGE_LINK, wordImportTestFile } from "./word-import-test-file.ts";

/** Where the stand-in API listens, which the screen is told is where the API is. */
const PORT = 43_217;

vi.mock("@/lib/api-url.ts", () => ({ apiBaseUrl: "http://127.0.0.1:43217/api" }));

// The app is bundled with mammoth's build for browsers, which reads a Word file
// from an `ArrayBuffer`. The build for Node, which tests would get, can't.
vi.mock("mammoth", async () => {
	const { createRequire } = await import("node:module");
	const browserBuild = createRequire(import.meta.url)("mammoth/mammoth.browser.js");
	return { ...browserBuild, default: browserBuild };
});

const POD_ID = "0199a3a0-0000-7000-8000-000000000001";
const ARTIFACT_ID = "0199a3a0-0000-7000-8000-000000000002";
/** A document the stand-in API keeps no image for, as when it can't be reached (see the server). */
const UNREACHABLE_ARTIFACT_ID = "0199a3a0-0000-7000-8000-000000000005";

let api: ChildProcess | undefined;

beforeAll(async () => {
	// Node's own WebSocket, the global here, cannot dispatch jsdom's events.
	vi.stubGlobal("WebSocket", NodeWebSocket);
	api = fork(join(import.meta.dirname, "live-document.test-server.ts"), [String(PORT)]);
	const listening = api;
	await new Promise((resolve) => listening.once("message", resolve));
});
afterEach(cleanup);
afterAll(() => {
	vi.unstubAllGlobals();
	api?.kill();
});

/** The editor on `artifactId`'s document, once it shows, with how to import a Word file into it. */
async function editing(artifactId: string) {
	let importWord: WordImport | undefined;
	render(
		<TooltipProvider>
			<LiveDocument
				workspaceId="workspace"
				podId={POD_ID}
				artifactId={artifactId}
				title="Launch plan"
				as={{ name: "Sam", email: "sam@example.com" }}
				bot={undefined}
				onWordImport={(importer) => {
					importWord = importer;
				}}
				presenceSlot={document.body}
				statusSlot={null}
			/>
		</TooltipProvider>,
	);
	expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeDefined();
	await waitFor(() => expect(importWord).toBeDefined());
	return { importWord: (file: File) => importWord?.(file) };
}

/** What the stand-in API's copy of the document holds, as markdown: what reached everyone else. */
async function markdownOf(artifactId: string) {
	const held = new Promise<{ markdown: string }>((resolve) => api?.once("message", resolve));
	api?.send({ artifactId, ask: "markdown" });
	return (await held).markdown;
}

describe("a document being edited live", () => {
	it("shows the document, then a bot's change to it and the bot's name as it lands", async () => {
		render(
			<TooltipProvider>
				<LiveDocument
					workspaceId="workspace"
					podId="pod"
					artifactId={ARTIFACT_ID}
					title="Launch plan"
					as={{ name: "Sam", email: "sam@example.com" }}
					bot={{ agentId: "agent", name: "Planner" }}
					onWordImport={() => {}}
					presenceSlot={document.body}
					statusSlot={null}
				/>
			</TooltipProvider>,
		);

		expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeDefined();
		expect(screen.getByText("Ship on Friday.")).toBeDefined();

		api?.send({ artifactId: ARTIFACT_ID, ask: "rewrite" });

		await waitFor(() => expect(screen.getByText("Ship on Monday.")).toBeDefined());
		expect(screen.getByRole("img", { name: "Planner" })).toBeDefined();
	});

	it("stops and says to reload when the document holds a block it cannot, deleting nothing", async () => {
		const artifactId = "0199a3a0-0000-7000-8000-000000000003";
		render(
			<TooltipProvider>
				<LiveDocument
					workspaceId="workspace"
					podId="pod"
					artifactId={artifactId}
					title="Launch plan"
					as={{ name: "Sam", email: "sam@example.com" }}
					bot={undefined}
					onWordImport={() => {}}
					presenceSlot={document.body}
					statusSlot={null}
				/>
			</TooltipProvider>,
		);
		expect(await screen.findByRole("heading", { name: "Launch plan" })).toBeDefined();

		// Somebody on a newer version of the app adds a block this editor has no node for.
		api?.send({ artifactId, ask: "unknown block" });

		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			expect.stringContaining("Reload to get the latest editor"),
		);
		// The heading, the paragraph and the block from elsewhere are all still in the document.
		const counted = new Promise<{ blocks: number }>((resolve) => api?.once("message", resolve));
		api?.send({ artifactId, ask: "count blocks" });
		expect(await counted).toEqual({ blocks: 3 });
	});
});

describe("links in the document", () => {
	const PLAN = "https://example.com/plan?from=doc";
	const LONG =
		"https://example.com/reports/2026/launch/a-long-path-that-goes-on/summary?view=full&section=risks&owner=planner";
	const CHART = "https://example.com/chart";
	/** How every link opens: in a new tab that gets no referrer and no hold on the document's. */
	const NEW_TAB = ["_blank", "noopener,noreferrer"] as const;

	let opened: MockInstance<typeof window.open>;
	beforeEach(() => {
		opened = vi.spyOn(window, "open").mockReturnValue(null);
	});
	afterEach(() => opened.mockRestore());

	/** The editor on `artifactId`'s document once a bot has written links into it, with the first link's words. */
	async function editingLinks(artifactId: string) {
		await editing(artifactId);
		const markdown = [
			"# Launch plan",
			`Read [the plan](${PLAN}) first, and [the long one](${LONG}).`,
			`[![The launch chart](/api/pods/${POD_ID}/artifacts/${artifactId}/images/${"c".repeat(64)})](${CHART})`,
			"Go to [settings](/settings), or [run it](javascript:alert(1)).",
		].join("\n\n");
		api?.send({ artifactId, ask: "rewrite", markdown });
		return await screen.findByText("the plan");
	}

	/** The editor drawing the text, which keeps itself on the element it draws into. */
	const editorOf = (element: Element) =>
		(element.closest(".ProseMirror") as HTMLElement & { editor: Editor }).editor;

	/** Where in the document `words` start. */
	function positionOf(editor: Editor, words: string): number {
		let found = -1;
		editor.state.doc.descendants((node, position) => {
			const at = node.isText ? (node.text ?? "").indexOf(words) : -1;
			if (found === -1 && at !== -1) found = position + at;
		});
		return found;
	}

	/** Puts the caret inside `words`, as a click there or the arrow keys would. */
	function caretIn(words: string): Editor {
		const editor = editorOf(screen.getByText(words));
		editor.commands.focus(positionOf(editor, words) + 2);
		return editor;
	}

	/** The menu for the link the caret is in. */
	const linkMenu = () => screen.findByRole("toolbar", { name: "Link" });

	/** The editor on a document holding links that can't be edited here, as when it holds content this tab can't show. */
	async function readingLinks(artifactId: string) {
		const link = await editingLinks(artifactId);
		api?.send({ artifactId, ask: "unknown block" });
		await screen.findByRole("alert");
		return link;
	}

	/** Asserts the dialog asks before `address` opens, showing the whole of it, and that nothing opened. */
	async function asksBefore(address: string) {
		const asking = await screen.findByRole("dialog", { name: "Open external link?" });
		expect(within(asking).getByText(address)).toBeDefined();
		const open = within(asking).getByRole("link", { name: "Open link" });
		expect([
			open.getAttribute("href"),
			open.getAttribute("target"),
			open.getAttribute("rel"),
		]).toEqual([address, "_blank", "noreferrer"]);
		expect(opened).not.toHaveBeenCalled();
	}

	it("places the caret on a plain click on a link's words, opening nothing and asking nothing", async () => {
		const link = await editingLinks("0199a3a0-0000-7000-8000-00000000000a");
		const words = link.firstChild as Text;

		// The browser puts the caret where the press was, then the click arrives.
		window.getSelection()?.collapse(words, 3);
		const followed = fireEvent.click(link, { detail: 1 });

		expect(followed).toBe(false);
		const caret = window.getSelection();
		expect([caret?.anchorNode, caret?.anchorOffset, caret?.isCollapsed]).toEqual([words, 3, true]);
		expect(opened).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("opens nothing on a Ctrl, Cmd or middle click on a link, a link into the app or a linked image, and stops the browser following it", async () => {
		await editingLinks("0199a3a0-0000-7000-8000-00000000000b");
		const links = [
			screen.getByText("the plan"),
			screen.getByText("settings"),
			screen.getByRole("img", { name: "The launch chart" }),
		];

		const followed = links.flatMap((link) => [
			fireEvent.click(link, { ctrlKey: true }),
			fireEvent.click(link, { metaKey: true }),
			fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })),
		]);

		expect(followed).toEqual(new Array(9).fill(false));
		expect(opened).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("opens nothing for a link to an address a text link may not go to, whose menu can't open it", async () => {
		await editingLinks("0199a3a0-0000-7000-8000-00000000000d");

		const followed = fireEvent.click(screen.getByText("run it"), { ctrlKey: true });
		caretIn("run it");

		expect(followed).toBe(false);
		const open = within(await linkMenu()).getByRole("button", { name: "Open link (Alt + Enter)" });
		expect(open).toHaveProperty("disabled", true);
		expect(opened).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("leaves a Shift or Alt click on a link's words to the editor, neither asking nor opening", async () => {
		const link = await editingLinks("0199a3a0-0000-7000-8000-00000000000e");
		const words = link.firstChild as Text;

		for (const modifier of [{ shiftKey: true }, { altKey: true }]) {
			// The selection a Shift click extends into the link, which the click leaves as it is.
			window.getSelection()?.setBaseAndExtent(words, 0, words, 4);
			const followed = fireEvent.click(link, { ...modifier, detail: 1 });

			expect(followed).toBe(false);
			expect(window.getSelection()?.toString()).toBe("the ");
		}
		expect(opened).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("shows the menu for the link the caret is in, with its address, which opens it at once", async () => {
		await editingLinks("0199a3a0-0000-7000-8000-000000000010");

		caretIn("the plan");
		const menu = await linkMenu();

		expect(menu.textContent).toContain(PLAN);
		fireEvent.click(within(menu).getByRole("button", { name: "Open link (Alt + Enter)" }));
		expect(opened.mock.calls).toEqual([[PLAN, ...NEW_TAB]]);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("opens the link whose menu shows on Alt and Enter, and nothing once the caret has left it", async () => {
		await editingLinks("0199a3a0-0000-7000-8000-00000000000c");
		const editor = caretIn("the plan");
		await linkMenu();

		const leftToTheEditor = fireEvent.keyDown(editor.view.dom, { key: "Enter", altKey: true });

		expect(leftToTheEditor).toBe(false);
		expect(opened.mock.calls).toEqual([[PLAN, ...NEW_TAB]]);
		expect(screen.queryByRole("dialog")).toBeNull();

		editor.commands.focus("start");
		await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Link" })).toBeNull());
		fireEvent.keyDown(editor.view.dom, { key: "Enter", altKey: true });

		expect(opened).toHaveBeenCalledTimes(1);
	});

	it("keeps a long address's host whole in the menu, cutting only what follows it", async () => {
		await editingLinks("0199a3a0-0000-7000-8000-000000000011");

		caretIn("the long one");
		const menu = await linkMenu();

		const host = within(menu).getByText("https://example.com");
		const rest = within(menu).getByText(LONG.slice("https://example.com".length));
		expect([host.className.includes("shrink-0"), rest.className.includes("truncate")]).toEqual([
			true,
			true,
		]);
	});

	it("copies the link's address from its menu", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		try {
			await editingLinks("0199a3a0-0000-7000-8000-000000000012");

			caretIn("the plan");
			fireEvent.click(within(await linkMenu()).getByRole("button", { name: "Copy link" }));

			expect(await screen.findByRole("button", { name: "Copied" })).toBeDefined();
			expect(writeText).toHaveBeenCalledWith(PLAN);
		} finally {
			Reflect.deleteProperty(navigator, "clipboard");
		}
	});

	it("changes the link's address from its menu, for everyone in the document", async () => {
		const artifactId = "0199a3a0-0000-7000-8000-000000000013";
		await editingLinks(artifactId);

		caretIn("the plan");
		fireEvent.click(within(await linkMenu()).getByRole("button", { name: "Edit link" }));
		const field = await screen.findByRole("textbox", { name: "Link address" });
		expect(field).toHaveProperty("value", PLAN);
		fireEvent.change(field, { target: { value: "example.com/new-plan" } });
		fireEvent.submit(field.closest("form") as HTMLFormElement);

		await waitFor(async () =>
			expect(await markdownOf(artifactId)).toContain(
				"[the plan](https://example.com/new-plan) first",
			),
		);
	});

	it("takes the link off its words from its menu, keeping the words", async () => {
		const artifactId = "0199a3a0-0000-7000-8000-000000000014";
		await editingLinks(artifactId);

		caretIn("the plan");
		fireEvent.click(within(await linkMenu()).getByRole("button", { name: "Remove link" }));

		await waitFor(() =>
			expect(screen.getByText("the plan", { exact: false }).closest("a")).toBeNull(),
		);
		await waitFor(async () =>
			expect(await markdownOf(artifactId)).toContain("Read the plan first"),
		);
	});

	it("shows the menu for a selected linked image, which opens its link", async () => {
		await editingLinks("0199a3a0-0000-7000-8000-000000000015");
		const editor = editorOf(screen.getByRole("img", { name: "The launch chart" }));
		let image = -1;
		editor.state.doc.descendants((node, position) => {
			if (node.type.name === "image") image = position;
		});

		editor.chain().focus().setNodeSelection(image).run();
		const menu = await linkMenu();

		expect(menu.textContent).toContain(CHART);
		fireEvent.click(within(menu).getByRole("button", { name: "Open link (Alt + Enter)" }));
		expect(opened.mock.calls).toEqual([[CHART, ...NEW_TAB]]);
	});

	it("shows no link menu for words selected inside a link, where the menu for selected text shows", async () => {
		await editingLinks("0199a3a0-0000-7000-8000-000000000016");
		const editor = editorOf(screen.getByText("the plan"));
		const start = positionOf(editor, "the plan");

		editor
			.chain()
			.focus()
			.setTextSelection({ from: start + 1, to: start + 6 })
			.run();

		expect(await screen.findByRole("toolbar", { name: "Selected text" })).toBeDefined();
		expect(screen.queryByRole("toolbar", { name: "Link" })).toBeNull();
	});

	it("asks before a plain click opens a link off the app where the document can't be edited", async () => {
		const link = await readingLinks("0199a3a0-0000-7000-8000-000000000017");

		const followed = fireEvent.click(link);

		expect(followed).toBe(false);
		await asksBefore(PLAN);
	});

	it("neither asks nor opens where the document can't be edited when the reader drags to select a link's words", async () => {
		const link = await readingLinks("0199a3a0-0000-7000-8000-000000000018");
		const words = link.firstChild as Text;

		// A press on the link, a drag along it and a release on it leave part of its words selected, then click.
		window.getSelection()?.setBaseAndExtent(words, 1, words, 6);
		const followed = fireEvent.click(link, { detail: 1 });

		expect(followed).toBe(false);
		expect(opened).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("asks where the document can't be edited on a click with no press of its own, with the link's words selected", async () => {
		const link = await readingLinks("0199a3a0-0000-7000-8000-000000000019");
		const words = link.firstChild as Text;
		window.getSelection()?.setBaseAndExtent(words, 0, words, 8);

		// Enter on the focused link, a screen reader or voice control clicks it with no press, and no count of presses.
		fireEvent.click(link, { detail: 0 });

		await asksBefore(PLAN);
	});
});

describe("importing a Word file", () => {
	it("brings in everything the document holds, keeping the image, and leaves out the rest", async () => {
		const artifactId = "0199a3a0-0000-7000-8000-000000000004";
		const editor = await editing(artifactId);

		await editor.importWord(await wordImportTestFile());

		expect(screen.getByRole("heading", { level: 1, name: "Word import test" })).toBeDefined();
		expect(
			screen.getByRole("heading", { level: 3, name: "2.1.1 A third-level heading" }),
		).toBeDefined();
		const table = screen.getByRole("table");
		expect(
			within(table)
				.getAllByRole("columnheader")
				.map((cell) => cell.textContent),
		).toEqual(["Milestone", "Owner", "Date"]);
		expect(within(table).getByRole("cell", { name: "Marco" })).toBeDefined();
		// Kept by the API, and loaded from the API wherever it is, under the address the document keeps.
		const image = screen.getByRole("img", { name: "A plain blue rectangle" });
		const kept = `/api/pods/${POD_ID}/artifacts/${artifactId}/images/[0-9a-f]{64}`;
		expect(image.getAttribute("data-address")).toMatch(new RegExp(`^${kept}$`));
		expect(image.getAttribute("src")).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:43217${kept}$`));
		expect(
			screen.getByRole("img", { name: "A one-pixel GIF" }).getAttribute("data-address"),
		).toMatch(new RegExp(`^${kept}$`));
		expect(
			screen.getByText("Ship the smallest thing that teaches you something.").closest("blockquote"),
		).not.toBeNull();
		expect(screen.queryByText(/PAGE HEADER|PAGE FOOTER/)).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();

		const markdown = await markdownOf(artifactId);
		for (const written of [
			"# Word import test",
			"## 2.1 A second-level heading",
			"<u>underlined</u>",
			"~~struck through~~",
			"<mark>highlighted text</mark>",
			"x<sup>2</sup> and H<sub>2</sub>O",
			"[the launch plan](https://example.com/launch-plan)",
			"“curly quotes”, an en dash (2024–2026), an ellipsis… and accents (café, naïve, Zürich)",
			"- Second bullet\n  - Nested under the second",
			"2. Review it\n   1. With legal",
			"> Ship the smallest thing that teaches you something.",
			"| Private beta",
			`![A plain blue rectangle](/api/pods/${POD_ID}/artifacts/${artifactId}/images/`,
			`![A one-pixel GIF](/api/pods/${POD_ID}/artifacts/${artifactId}/images/`,
			"Run `bun run dev` to start the app.",
			'```\nfunction greet(name) {\n  if (name && name.length < 40) return "<b>" + name;\n}\n```',
			// The horizontal line Word draws, the line three typed hyphens make, and the page break.
			"A right-aligned paragraph.\n\n---\n\n---\n\n---\n\n# 9. After the page break",
		]) {
			expect(markdown).toContain(written);
		}
		expect(markdown).toContain("Formatting the editor has no mark for: red text,");
		expect(markdown).not.toMatch(/PAGE HEADER|PAGE FOOTER|data:image/);
	});

	it("brings a linked image, and its link, to everyone else in the document", async () => {
		const artifactId = "0199a3a0-0000-7000-8000-000000000009";
		const editor = await editing(artifactId);
		const linkAround = (image: HTMLElement) => image.closest("a")?.getAttribute("href");

		await editor.importWord(await wordImportTestFile());

		expect(linkAround(screen.getByRole("img", { name: "A linked image" }))).toBe(LINKED_IMAGE_LINK);
		const someoneElse = render(
			<TooltipProvider>
				<LiveDocument
					workspaceId="workspace"
					podId={POD_ID}
					artifactId={artifactId}
					title="Launch plan"
					as={{ name: "Kim", email: "kim@example.com" }}
					bot={undefined}
					onWordImport={() => {}}
					presenceSlot={document.body}
					statusSlot={null}
				/>
			</TooltipProvider>,
		);
		const received = await within(someoneElse.container).findByRole("img", {
			name: "A linked image",
		});
		expect(linkAround(received)).toBe(LINKED_IMAGE_LINK);
		expect(await markdownOf(artifactId)).toMatch(
			new RegExp(
				`\\[!\\[A linked image\\]\\(/api/pods/${POD_ID}/artifacts/${artifactId}/images/[0-9a-f]{64}\\)\\]\\(${LINKED_IMAGE_LINK.replaceAll(".", "\\.")}\\)`,
			),
		);
	});

	it("says so when it leaves out an image of a kind the document doesn't show", async () => {
		const artifactId = "0199a3a0-0000-7000-8000-000000000006";
		const editor = await editing(artifactId);

		await editor.importWord(await wordImportTestFile({ image: "bmp" }));

		expect(screen.getByRole("heading", { level: 1, name: "Word import test" })).toBeDefined();
		expect(screen.queryByRole("img", { name: "A plain blue rectangle" })).toBeNull();
		expect((await screen.findByRole("alert")).textContent).toContain(
			"1 image in the Word file was left out.",
		);
	});

	it("keeps an image as the kind its bytes are, whatever the file says it is", async () => {
		const artifactId = "0199a3a0-0000-7000-8000-000000000008";
		const editor = await editing(artifactId);

		// The stand-in API, as the API does, refuses an image sent as a kind its bytes aren't.
		await editor.importWord(await wordImportTestFile({ image: "gif called png" }));

		const image = screen.getByRole("img", { name: "A plain blue rectangle" });
		expect(image.getAttribute("data-address")).toMatch(
			new RegExp(`^/api/pods/${POD_ID}/artifacts/${artifactId}/images/[0-9a-f]{64}$`),
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("changes nothing, and says so, when the file isn't one it can read", async () => {
		const artifactId = "0199a3a0-0000-7000-8000-000000000007";
		const editor = await editing(artifactId);

		await editor.importWord(new File(["not a Word file"], "notes.docx"));

		expect((await screen.findByRole("alert")).textContent).toContain(
			"The Word file wasn't imported, so the document is as it was. It couldn't be read as a Word document.",
		);
		expect(screen.getByText("Ship on Friday.")).toBeDefined();
	});

	it("changes nothing, and says why, when an image it would keep can't be kept", async () => {
		const editor = await editing(UNREACHABLE_ARTIFACT_ID);

		await editor.importWord(await wordImportTestFile());

		expect((await screen.findByRole("alert")).textContent).toContain(
			"The Word file wasn't imported, so the document is as it was.",
		);
		expect(screen.getByText("Ship on Friday.")).toBeDefined();
		expect(screen.queryByRole("heading", { name: "Word import test" })).toBeNull();
		expect((await markdownOf(UNREACHABLE_ARTIFACT_ID)).trim()).toBe(
			"# Launch plan\n\nShip on Friday.",
		);
	});
});

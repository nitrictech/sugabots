import { artifactImageAddress, artifactImageIds } from "@sugabots/contracts/http";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/ui/tooltip.tsx";
import { ARTIFACT_KINDS } from "./artifact-kinds.tsx";

/** Where the API is, on an origin of its own, as when the web app is hosted apart from it. */
vi.mock("@/lib/api-url.ts", () => ({ apiBaseUrl: "https://api.example.com/api" }));

afterEach(cleanup);

const POD_ID = "0199a3a0-0000-7000-8000-000000000001";
const ARTIFACT_ID = "0199a3a0-0000-7000-8000-000000000002";

function imageKeptFor(artifactId: string) {
	const ids = artifactImageIds({ podId: POD_ID, artifactId, imageId: "b".repeat(64) });
	if (!ids) throw new Error("fixture");
	return artifactImageAddress(ids);
}

/** The document, opened large without editing, holding `content`. */
function reading(content: string) {
	const { Full } = ARTIFACT_KINDS.document;
	return render(
		<TooltipProvider>
			<Full
				title="Launch plan"
				at={{ podId: POD_ID, artifactId: ARTIFACT_ID, version: 1 }}
				content={content}
			/>
		</TooltipProvider>,
	);
}

describe("a document read without editing", () => {
	it("draws the marks its editor writes as tags", () => {
		const { container } = reading(
			"x<sup>2</sup>, H<sub>2</sub>O, <u>firm</u> and <mark>launch day</mark>.",
		);

		expect(container.querySelector("sup")?.textContent).toBe("2");
		expect(container.querySelector("sub")?.textContent).toBe("2");
		expect(container.querySelector("u")?.textContent).toBe("firm");
		expect(container.querySelector("mark")?.textContent).toBe("launch day");
	});

	it("draws a table, with its header row and a cell's lines", () => {
		reading("| Milestone | Notes |\n| --- | --- |\n| Beta | First<br>Second |");

		const table = screen.getByRole("table");
		expect(within(table).getByRole("columnheader", { name: "Milestone" })).toBeDefined();
		expect(within(table).getByRole("cell", { name: /First/ }).querySelector("br")).not.toBeNull();
	});

	it("loads an image it keeps from the API, wherever the API is", () => {
		const kept = imageKeptFor(ARTIFACT_ID);

		reading(`![The launch chart](${kept})`);

		expect(screen.getByRole("img", { name: "The launch chart" }).getAttribute("src")).toBe(
			`https://api.example.com${kept}`,
		);
	});

	it("draws another document's image, and one from outside, as links that load nothing", () => {
		reading(
			`![Their chart](${imageKeptFor("0199a3a0-0000-7000-8000-000000000009")}) ![A tracker](https://tracker.example/pixel.png)`,
		);

		expect(screen.queryByRole("img")).toBeNull();
		expect(screen.getByRole("link", { name: /Their chart/ })).toBeDefined();
		expect(screen.getByRole("link", { name: /A tracker/ })).toBeDefined();
	});

	it("draws a linked image it keeps inside its link, which asks before leaving, and another's as the link's words", async () => {
		const kept = imageKeptFor(ARTIFACT_ID);

		reading(
			`[![The launch chart](${kept})](https://example.com/chart) [![Their chart](${imageKeptFor("0199a3a0-0000-7000-8000-000000000009")})](https://example.com/theirs)`,
		);

		expect(screen.getAllByRole("img")).toHaveLength(1);
		const image = screen.getByRole("img", { name: "The launch chart" });
		expect(image.getAttribute("src")).toBe(`https://api.example.com${kept}`);
		const link = image.closest("a");
		expect(link?.getAttribute("href")).toBe("https://example.com/chart");
		expect(screen.getByRole("link", { name: "Their chart" }).getAttribute("href")).toBe(
			"https://example.com/theirs",
		);
		if (link) fireEvent.click(link);
		expect(await screen.findByText("Open external link?")).toBeDefined();
	});

	it("shows any other HTML as its text", () => {
		const { container } = reading("<script>alert(1)</script> <u class=x>styled</u> <b>bold</b>");

		expect(container.querySelector("script, b")).toBeNull();
		expect(container.textContent).toContain(
			"<script>alert(1)</script> <u class=x>styled</u> <b>bold</b>",
		);
	});
});

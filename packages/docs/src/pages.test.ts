import { describe, expect, it } from "vitest";
import { docPages } from "./pages.ts";

const COMPONENT_TAG = /<\/?[A-Z]\w*/;

describe("docs pages as Markdown", () => {
	it.each(docPages.map((page) => [page.slug, page] as const))(
		"writes the %s page without component tags",
		(_slug, page) => {
			expect(page.markdown).not.toMatch(COMPONENT_TAG);
		},
	);
});

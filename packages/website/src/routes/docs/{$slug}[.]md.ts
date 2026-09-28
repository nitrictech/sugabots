import { createFileRoute } from "@tanstack/react-router";
import { findDocPage } from "@/docs/pages";
import { markdownResponse } from "@/markdown";

export const Route = createFileRoute("/docs/{$slug}.md")({
	server: {
		handlers: {
			GET: ({ params }) => {
				const page = findDocPage(params.slug);
				if (!page) return new Response("Not found", { status: 404 });
				return markdownResponse(page.markdown);
			},
		},
	},
});

import { createFileRoute } from "@tanstack/react-router";
import { docsIndexMarkdown } from "@/llms";
import { markdownResponse } from "@/markdown";

export const Route = createFileRoute("/docs.md")({
	server: { handlers: { GET: () => markdownResponse(docsIndexMarkdown()) } },
});

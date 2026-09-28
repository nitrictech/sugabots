import { createFileRoute } from "@tanstack/react-router";
import { siteMarkdown } from "@/llms";
import { markdownResponse } from "@/markdown";

export const Route = createFileRoute("/index.md")({
	server: { handlers: { GET: () => markdownResponse(siteMarkdown()) } },
});

import { createFileRoute } from "@tanstack/react-router";
import { siteMarkdown } from "@/llms";
import { markdownResponse } from "@/markdown";

export const Route = createFileRoute("/llms.txt")({
	server: { handlers: { GET: () => markdownResponse(siteMarkdown()) } },
});

import { createFileRoute } from "@tanstack/react-router";
import { fullDocsMarkdown } from "@/llms";
import { markdownResponse } from "@/markdown";

export const Route = createFileRoute("/llms-full.txt")({
	server: { handlers: { GET: () => markdownResponse(fullDocsMarkdown()) } },
});

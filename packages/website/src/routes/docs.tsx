import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site-header";
import { DocsMenu } from "@/docs/components/docs-nav";

export const Route = createFileRoute("/docs")({ component: DocsLayout });

function DocsLayout() {
	return (
		<>
			<SiteHeader
				placement="docs_header"
				inDocs
				badge={{ label: "Docs", href: "/docs" }}
				menu={<DocsMenu />}
			/>
			<Outlet />
		</>
	);
}

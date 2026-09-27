import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DocsHeader } from "@/docs/components/docs-header";

export const Route = createFileRoute("/docs")({ component: DocsLayout });

function DocsLayout() {
	return (
		<>
			<DocsHeader />
			<Outlet />
		</>
	);
}

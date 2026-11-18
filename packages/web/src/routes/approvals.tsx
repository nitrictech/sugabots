import { createRoute, Outlet } from "@tanstack/react-router";
import { ApprovalPage } from "@/screens/ApprovalPage.tsx";
import { Approvals } from "@/shell/Approvals.tsx";
import { Panes } from "@/shell/Shell.tsx";
import { shellRoute } from "./workspace.tsx";

/** Every approval across the workspace, and each one in full on its own page. */
export const approvalsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/approvals",
	component: () => (
		<Panes>
			<Outlet />
		</Panes>
	),
});

export const approvalsIndexRoute = createRoute({
	getParentRoute: () => approvalsRoute,
	path: "/",
	component: Approvals,
});

export const approvalRoute = createRoute({
	getParentRoute: () => approvalsRoute,
	path: "/$call",
	component: () => <ApprovalPage callId={approvalRoute.useParams().call} />,
});

import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { createQueryClient } from "@/lib/query.ts";

/** Renders `children` inside a route, where `useWorkspace` reads the workspace from. */
export function InRoute({
	children,
	queries: given,
}: {
	children: ReactNode;
	queries?: QueryClient;
}) {
	const [queries] = useState(() => given ?? createQueryClient());
	const [router] = useState(() =>
		createRouter({
			routeTree: createRootRoute({ component: () => children }),
			history: createMemoryHistory(),
		}),
	);
	return (
		<QueryClientProvider client={queries}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
}

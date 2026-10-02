import type { Me } from "@sugabots/contracts";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { failureMessage } from "@/lib/failure.ts";
import { onboardingQuery } from "@/lib/onboarding.ts";
import { createQueryClient } from "@/lib/query.ts";
import { type Session, useSessionFromApi } from "@/lib/session.ts";
import { reloadWhenADeployReplacesChunks } from "@/lib/stale-chunks.ts";
import { workspacesQuery } from "@/lib/workspace.ts";
import { AppRouterProvider, createAppRouter } from "@/router.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { TooltipProvider } from "@/ui/tooltip.tsx";
import "@/app.css";

/**
 * The router is created once, outside the tree, and handed the session as
 * context on every render.
 *
 * Nothing mounts until `/me` has answered. A route guard has to be able to say
 * yes or no, and "not known yet" is neither: mounting first would send everyone
 * to the login page for a frame, then bounce those with a good token back,
 * which the address bar and the back button both remember.
 */

const router = createAppRouter();

function App() {
	const session = useSessionFromApi();
	const [retryingSession, setRetryingSession] = useState(false);

	if (session.user === undefined) {
		return session.error ? (
			<div className="grid h-full place-items-center bg-list">
				<EmptyState title="Could not check your session">
					<div className="flex flex-col items-center gap-3">
						<p>{failureMessage(session.error)}</p>
						<Button
							variant="outline"
							disabled={retryingSession}
							onClick={() => {
								setRetryingSession(true);
								void session
									.refresh()
									.catch(() => {})
									.finally(() => setRetryingSession(false));
							}}
						>
							{retryingSession ? "Trying again…" : "Try again"}
						</Button>
					</div>
				</EmptyState>
			</div>
		) : (
			<Splash />
		);
	}

	return <SessionRouter key={session.user?.id ?? "signed-out"} session={session} />;
}

function SessionRouter({ session }: { session: Session }) {
	const [queries] = useState(() => queriesStartingFrom(session.me));

	return (
		<QueryClientProvider client={queries}>
			<TooltipProvider>
				<AppRouterProvider router={router} session={session} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/**
 * A query cache for one session, already holding the onboarding and workspaces
 * `/me` answered with, so the shell need not ask for them again.
 */
function queriesStartingFrom(me: Me | undefined): QueryClient {
	const queries = createQueryClient();
	if (me) {
		queries.setQueryData(onboardingQuery.queryKey, me.onboarding);
		queries.setQueryData(workspacesQuery.queryKey, me.workspaces);
	}
	return queries;
}

/**
 * The gap before the first paint of the app proper. Deliberately not a spinner:
 * it is one request against a local API, and a spinner that flashes for 40ms
 * reads as a fault.
 */
function Splash() {
	return <div className="h-full bg-list" />;
}

reloadWhenADeployReplacesChunks();

const root = document.getElementById("root");
if (!root) {
	throw new Error("missing #root");
}

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

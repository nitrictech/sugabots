import { QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterProvider } from "@tanstack/react-router";
import { type ReactNode, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { failureMessage } from "@/lib/failure.ts";
import { createQueryClient } from "@/lib/query.ts";
import { forgetSavedQueries, savedQueriesFor } from "@/lib/query-persistence.ts";
import { type Session, useSession } from "@/lib/session.ts";
import { createAppRouter } from "@/router.tsx";
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
	const session = useSession();
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
	const [queries] = useState(createQueryClient);
	const app = (
		<TooltipProvider>
			<RouterProvider router={router} context={{ session }} />
		</TooltipProvider>
	);

	return session.user ? (
		<SavedQueries userId={session.user.id} client={queries}>
			{app}
		</SavedQueries>
	) : (
		<SignedOutQueries client={queries}>{app}</SignedOutQueries>
	);
}

/**
 * The signed-in person's queries, drawn from what their last visit saved while
 * the API is asked again. Queries wait until the saved ones are back, so the
 * saved answer is what they start from.
 */
function SavedQueries({
	userId,
	client,
	children,
}: {
	userId: string;
	client: ReturnType<typeof createQueryClient>;
	children: ReactNode;
}) {
	const [{ persistOptions, saveWhileMounted }] = useState(() => savedQueriesFor(userId));
	useEffect(saveWhileMounted, [saveWhileMounted]);
	return (
		<PersistQueryClientProvider client={client} persistOptions={persistOptions}>
			{children}
		</PersistQueryClientProvider>
	);
}

/** Nobody is signed in, so nothing anybody saved is kept: it is their conversations. */
function SignedOutQueries({
	client,
	children,
}: {
	client: ReturnType<typeof createQueryClient>;
	children: ReactNode;
}) {
	useEffect(() => {
		void forgetSavedQueries();
	}, []);
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * The gap before the first paint of the app proper. Deliberately not a spinner:
 * it is one request against a local API, and a spinner that flashes for 40ms
 * reads as a fault.
 */
function Splash() {
	return <div className="h-full bg-list" />;
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("missing #root");
}

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

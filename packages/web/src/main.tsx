import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { failureMessage } from "@/lib/failure.ts";
import { createQueryClient } from "@/lib/query.ts";
import { type Session, useSessionFromApi } from "@/lib/session.ts";
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
	const [queries] = useState(createQueryClient);

	return (
		<QueryClientProvider client={queries}>
			<TooltipProvider>
				<AppRouterProvider router={router} session={session} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/**
 * The gap before the first paint of the app proper. Deliberately not a spinner:
 * it is one request against a local API, and a spinner that flashes for 40ms
 * reads as a fault.
 */
function Splash() {
	return <div className="h-full bg-list" />;
}

/*
 * A deploy replaces every hashed chunk, so a tab opened before it fails to load
 * any chunk it has not fetched yet. Reloading picks up the new `index.html` and
 * its hashes. A second failure soon after the reload is a chunk that is really
 * missing, and is left to throw rather than reload forever.
 */
const STALE_CHUNK_RELOADED_AT = "stale-chunk-reloaded-at";
const STALE_CHUNK_RELOAD_COOLDOWN_MS = 10_000;

window.addEventListener("vite:preloadError", (event) => {
	const reloadedAt = Number(readSessionStorage(STALE_CHUNK_RELOADED_AT));
	if (Date.now() - reloadedAt < STALE_CHUNK_RELOAD_COOLDOWN_MS) {
		return;
	}
	event.preventDefault();
	writeSessionStorage(STALE_CHUNK_RELOADED_AT, String(Date.now()));
	window.location.reload();
});

/** Storage can throw in private windows or with site data blocked. */
function readSessionStorage(key: string): string | null {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeSessionStorage(key: string, value: string) {
	try {
		sessionStorage.setItem(key, value);
	} catch {}
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

import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";

/**
 * What the router shows in place of a page that failed to download or threw
 * while rendering. A failed download usually reloads the page before this
 * shows, so this is the fallback. It takes the failed page's place only, so
 * the rail and lists around it stay, and opening another page clears it.
 *
 * It offers a reload rather than a retry: a browser can keep a failed import
 * for the life of the page, and React's `lazy` keeps the failure too, so
 * rendering the page again would fail the same way.
 */
export function PageFailure() {
	return (
		// Fills whichever parent the failed page had: the shell's row, a pane's column, or the whole page.
		<div className="flex h-full min-w-0 flex-1 bg-background">
			<EmptyState title="This page could not load">
				<div className="flex flex-col items-center gap-3">
					<p>Reload the page to try again.</p>
					<Button variant="outline" onClick={() => window.location.reload()}>
						Reload
					</Button>
				</div>
			</EmptyState>
		</div>
	);
}

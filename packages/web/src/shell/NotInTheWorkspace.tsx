import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";

/**
 * In place of setup for somebody in no workspace, on an installation that
 * holds a single workspace which somebody else has made. Only an invitation
 * gets them in, so the way on is signing out.
 */
export function NotInTheWorkspace({ onSignOut }: { onSignOut: () => void }) {
	return (
		<div className="grid h-full place-items-center bg-list p-6">
			<EmptyState title="You're not in this server's workspace">
				<div className="flex flex-col items-center gap-3">
					<p>Ask somebody in it to invite you, or sign in with another account.</p>
					<Button variant="outline" onClick={onSignOut}>
						Sign out
					</Button>
				</div>
			</EmptyState>
		</div>
	);
}

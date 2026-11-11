import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";

/**
 * In place of the whole app when something it cannot open without, such as
 * your session or your workspaces, failed to load.
 */
export function LoadFailure({
	title,
	error,
	retry,
}: {
	title: string;
	/** Why it failed. Empty while a query asks again, which clears its error. */
	error: unknown;
	/** Asks again. Settles once the answer is in, so the button can say it is waiting. */
	retry: () => Promise<unknown>;
}) {
	const [retrying, setRetrying] = useState(false);

	return (
		<div className="grid h-full place-items-center bg-list p-6">
			<EmptyState title={title}>
				<div className="flex flex-col items-center gap-3">
					{error != null && <p>{failureMessage(error)}</p>}
					<Button
						variant="outline"
						disabled={retrying}
						onClick={() => {
							setRetrying(true);
							void retry()
								.catch(() => {})
								.finally(() => setRetrying(false));
						}}
					>
						{retrying ? "Trying again…" : "Try again"}
					</Button>
				</div>
			</EmptyState>
		</div>
	);
}

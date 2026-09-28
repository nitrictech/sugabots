import type { ThreadNotice } from "@/lib/thread-events.ts";

/*
 * What a thread was told that no message in it records, below its messages:
 * why a reply somebody asked for is not coming. Without it the thread just
 * stays quiet, and nobody can tell a slow agent from one that will never answer.
 *
 * The status region is there even while empty, so a screen reader announces a
 * notice as it arrives.
 */
export function ThreadNotices({ notices }: { notices: readonly ThreadNotice[] }) {
	return (
		<div role="status" aria-label="Thread notices" className="flex flex-col gap-1">
			{notices.map((notice) => (
				<p key={notice.id} className="m-0 text-center text-destructive-text text-xs first:mt-3">
					{notice.text}
				</p>
			))}
		</div>
	);
}

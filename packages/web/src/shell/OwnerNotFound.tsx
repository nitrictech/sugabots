import { API_DID_NOT_ANSWER } from "@/lib/failure.ts";
import { Panes } from "@/shell/Shell.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";

/** Why the viewer may find no bot or project at an address that names one. */
const NOT_FOUND_REASONS = {
	bot: "It may have been removed or renamed, or it is someone else's personal bot.",
	project: "It may have been removed, or it is private and you're not in it.",
} as const;

/**
 * In place of a bot's or a project's pages when its address names none the
 * viewer reaches: that it could not be loaded, while `error` says the list
 * failed, and otherwise that there is no such one.
 */
export function OwnerNotFound({ kind, error }: { kind: "bot" | "project"; error: unknown }) {
	return (
		<Panes>
			<EmptyState title={error ? `Could not load this ${kind}` : `No such ${kind} here`}>
				{error ? API_DID_NOT_ANSWER : NOT_FOUND_REASONS[kind]}
			</EmptyState>
		</Panes>
	);
}

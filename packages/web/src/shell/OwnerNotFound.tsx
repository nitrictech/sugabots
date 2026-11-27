import { Link } from "@tanstack/react-router";
import { API_DID_NOT_ANSWER } from "@/lib/failure.ts";
import { botsLink, projectsLink } from "@/lib/links.ts";
import { Panes } from "@/shell/Shell.tsx";
import { buttonStyles } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";

/** Why the viewer may find no bot or project at an address that names one. */
const NOT_FOUND_REASONS = {
	bot: "This bot may have moved, been removed, or be unavailable to you. If someone sent you this link, ask them to check it or add you to the bot.",
	project:
		"This project may have moved, been removed, or be unavailable to you. If someone sent you this link, ask them to check it or add you to the project.",
} as const;

/**
 * In place of a bot's or a project's pages when its address names none the
 * viewer reaches: that it could not be loaded, while `error` says the list
 * failed, and otherwise that there is no such one.
 */
export function OwnerNotFound({ kind, error }: { kind: "bot" | "project"; error: unknown }) {
	return (
		<Panes>
			<EmptyState
				title={error ? `Could not load this ${kind}` : `No such ${kind} here`}
				actions={
					!error && (
						<Link
							{...(kind === "bot" ? botsLink() : projectsLink())}
							className={buttonStyles({ variant: "secondary", size: "sm" })}
						>
							{kind === "bot" ? "Browse bots" : "Browse projects"}
						</Link>
					)
				}
			>
				{error ? API_DID_NOT_ANSWER : NOT_FOUND_REASONS[kind]}
			</EmptyState>
		</Panes>
	);
}

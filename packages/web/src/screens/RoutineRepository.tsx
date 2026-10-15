import { type GitHubTrigger, REPOSITORY_EVENTS, type RepositoryEvent } from "@sugabots/contracts";
import { Check } from "lucide-react";
import { useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useConnectionRepositories } from "@/lib/github-connections.ts";
import { Alert } from "@/ui/alert.tsx";
import { Note } from "@/ui/note.tsx";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";

/*
 * What a repository routine runs on: one of its bot's pod's GitHub
 * connection's repositories, and what happening there starts a run.
 */

/** Each event as its switch says it. */
export const REPOSITORY_EVENT_LABELS: Record<RepositoryEvent, string> = {
	pull_request_opened: "A pull request is opened",
	pull_request_review: "A pull request is reviewed",
	pull_request_comment: "Someone comments on a pull request",
	issue_opened: "An issue is opened",
	issue_comment: "Someone comments on an issue",
	checks_failed: "Checks fail",
	push: "A branch is pushed to",
};

/** What a repository routine runs on until somebody chooses. */
export const DEFAULT_REPOSITORY_EVENTS: readonly RepositoryEvent[] = ["pull_request_opened"];

/** A repository trigger as written, before its repository is chosen. */
export interface RepositoryDraft {
	repository: Pick<GitHubTrigger, "connectionId" | "repository"> | undefined;
	events: readonly RepositoryEvent[];
}

export const NEW_REPOSITORY_TRIGGER: RepositoryDraft = {
	repository: undefined,
	events: DEFAULT_REPOSITORY_EVENTS,
};

/** The trigger `draft` saves as, once it names a repository and an event. */
export function repositoryTrigger(draft: RepositoryDraft) {
	if (!draft.repository || draft.events.length === 0) return undefined;
	return { kind: "github" as const, ...draft.repository, events: draft.events };
}

export const PICK_AN_EVENT_NOTE = "Pick at least one thing for it to run on.";

/**
 * The repository and events groups, for a routine on a bot in `podId`.
 * Its pod's GitHub connection's repositories are the ones to choose from.
 */
export function RepositoryGroups({
	podId,
	podName,
	draft,
	onChange,
}: {
	podId: string;
	podName: string;
	draft: RepositoryDraft;
	onChange: (draft: RepositoryDraft) => void;
}) {
	const connections = useConnections(podId);
	const connectionId = connections.data?.find((one) => one.kind === "github")?.id;
	const { repositories } = useConnectionRepositories(podId, connectionId);
	if (connections.isPending) return null;
	if (connections.isError) return <Alert>{failureMessage(connections.error)}</Alert>;
	if (connectionId && repositories.isPending) return null;
	if (repositories.isError) return <Alert>{failureMessage(repositories.error)}</Alert>;
	const choices = connectionId ? (repositories.data?.repositories ?? []) : [];
	if (!connectionId || choices.length === 0) {
		return (
			<Note>
				{podName} isn't connected to any GitHub repositories yet. Someone who manages its
				connections can connect GitHub in the pod's settings.
			</Note>
		);
	}
	const chosen = draft.repository;
	const isChosen = (choice: (typeof choices)[number]) =>
		connectionId === chosen?.connectionId &&
		choice.repository.toLowerCase() === chosen.repository.toLowerCase();
	return (
		<>
			<SettingsGroup label="Repository" note={`${podName}'s repositories.`}>
				{choices.map((choice) => (
					<SettingsRow
						key={choice.repository}
						label={<span className="font-mono text-[13.5px]">{choice.repository}</span>}
						trailing={
							isChosen(choice) ? (
								<Check aria-hidden size={16} strokeWidth={2.4} className="text-link" />
							) : undefined
						}
						onClick={() =>
							onChange({
								...draft,
								repository: { connectionId, repository: choice.repository },
							})
						}
					/>
				))}
			</SettingsGroup>
			<SettingsGroup
				label="Runs when"
				note={
					draft.events.length === 0
						? PICK_AN_EVENT_NOTE
						: "What the bots' own pushes, comments and pull requests cause doesn't run it."
				}
			>
				{REPOSITORY_EVENTS.map((event) => (
					<div
						key={event}
						className="flex min-h-[46px] items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0"
					>
						<span className="flex-1 text-[14.5px] text-foreground">
							{REPOSITORY_EVENT_LABELS[event]}
						</span>
						<Toggle
							label={REPOSITORY_EVENT_LABELS[event]}
							checked={draft.events.includes(event)}
							onChange={(on) =>
								onChange({
									...draft,
									events: on
										? REPOSITORY_EVENTS.filter(
												(candidate) => candidate === event || draft.events.includes(candidate),
											)
										: draft.events.filter((candidate) => candidate !== event),
								})
							}
						/>
					</div>
				))}
			</SettingsGroup>
		</>
	);
}

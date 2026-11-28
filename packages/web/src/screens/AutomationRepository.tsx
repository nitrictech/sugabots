import { type GitHubTrigger, REPOSITORY_EVENTS, type RepositoryEvent } from "@sugabots/contracts";
import { Check } from "lucide-react";
import { REPOSITORY_EVENT_LABELS } from "@/lib/automation-trigger-words.ts";
import { useConnectors } from "@/lib/connectors.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useConnectorRepositories } from "@/lib/github-connectors.ts";
import {
	OwnerLink,
	ownerName,
	type ResourceOwner,
	resourceProjectId,
} from "@/lib/resource-owner.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Note } from "@/ui/note.tsx";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";
import { Switch } from "@/ui/switch.tsx";

/*
 * What a repository automation runs on: one of the repositories its project's
 * GitHub app reaches, and what happening there starts a run.
 */

/** What a repository automation runs on until somebody chooses. */
const DEFAULT_REPOSITORY_EVENTS: readonly RepositoryEvent[] = ["pull_request_opened"];

/** A repository trigger as written, before its repository is chosen. */
export interface RepositoryDraft {
	repository: Pick<GitHubTrigger, "connectorId" | "repository"> | undefined;
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
 * RepositoryGroups shows the saved repository, events and any repositories
 * the automation's owner can switch to.
 */
export function RepositoryGroups({
	owner,
	draft,
	onChange,
}: {
	owner: ResourceOwner;
	draft: RepositoryDraft;
	onChange: (draft: RepositoryDraft) => void;
}) {
	const projectId = resourceProjectId(owner);
	const name = ownerName(owner);
	const connectors = useConnectors(projectId);
	const connectorId = connectors.data?.find((one) => one.kind === "github")?.id;
	const { repositories } = useConnectorRepositories(projectId, connectorId);
	if (connectors.isPending) return null;
	if (connectors.isError) return <Alert>{failureMessage(connectors.error)}</Alert>;
	const chosen = draft.repository;
	const usesDifferentApp = chosen !== undefined && chosen.connectorId !== connectorId;
	if (!usesDifferentApp && connectorId && repositories.isPending) return null;
	if (!usesDifferentApp && repositories.isError)
		return <Alert>{failureMessage(repositories.error)}</Alert>;
	const choices = connectorId ? (repositories.data?.repositories ?? []) : [];
	const connectGitHubNote = (
		<Note>
			{name} has no GitHub repositories to choose from. Someone who manages its connectors can add
			one on the{" "}
			<OwnerLink owner={owner} to={{ page: "connectors" }} className="text-link underline">
				Connectors page
			</OwnerLink>
			.
		</Note>
	);
	if (!usesDifferentApp && choices.length === 0) {
		return connectGitHubNote;
	}
	const switchAppNote =
		choices.length > 0 ? ` Pick one of ${name}'s repositories to switch apps.` : "";
	const repositoryNote = usesDifferentApp
		? `This trigger is still set to use its previous GitHub app.${switchAppNote}`
		: `${name}'s repositories.`;
	const isChosen = (choice: (typeof choices)[number]) =>
		chosen !== undefined &&
		connectorId === chosen.connectorId &&
		choice.repository.toLowerCase() === chosen.repository.toLowerCase();
	return (
		<>
			<SettingsGroup label="Repository" note={repositoryNote}>
				{usesDifferentApp && (
					<SettingsRow
						label={<span className="font-mono text-xs">{chosen.repository}</span>}
						sub="Current repository"
					/>
				)}
				{connectorId &&
					choices.map((choice) => (
						<SettingsRow
							key={choice.repository}
							label={<span className="font-mono text-xs">{choice.repository}</span>}
							trailing={
								isChosen(choice) ? (
									<Check aria-hidden size={16} strokeWidth={2.4} className="text-link" />
								) : undefined
							}
							onClick={() =>
								onChange({
									...draft,
									repository: { connectorId, repository: choice.repository },
								})
							}
						/>
					))}
			</SettingsGroup>
			{usesDifferentApp && repositories.isError && (
				<Alert>{failureMessage(repositories.error)}</Alert>
			)}
			{usesDifferentApp &&
				(!connectorId || (repositories.isSuccess && choices.length === 0)) &&
				connectGitHubNote}
			<SettingsGroup
				label="Runs when"
				note={
					draft.events.length === 0
						? PICK_AN_EVENT_NOTE
						: "What the bots' own pushes, comments and pull requests cause doesn't run it."
				}
			>
				{REPOSITORY_EVENTS.map((event) => (
					<SettingsRow
						key={event}
						label={REPOSITORY_EVENT_LABELS[event]}
						trailing={
							<Switch
								aria-label={REPOSITORY_EVENT_LABELS[event]}
								checked={draft.events.includes(event)}
								onCheckedChange={(on) =>
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
						}
					/>
				))}
			</SettingsGroup>
		</>
	);
}

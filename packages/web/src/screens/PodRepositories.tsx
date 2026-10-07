import type { AvailableRepositories, PodRepositories, PodRepository } from "@sugabots/contracts";
import { X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useAvailableRepositories, usePodRepositories } from "@/lib/git-hosts.ts";
import { Alert } from "@/ui/alert.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsControlRow, SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";

/**
 * The repositories the pod's bots work on: they read them in the sandbox, and
 * push branches and open pull requests on them once someone allows it.
 * `canManage` is whether the person may add and remove them, from what the
 * workspace's GitHub Apps reach.
 */
export function PodRepositoriesSettings({
	podId,
	canManage,
}: {
	podId: string;
	canManage: boolean;
}) {
	const { repositories, add, remove } = usePodRepositories(podId);
	const available = useAvailableRepositories(podId, canManage);
	if (repositories.isPending) return null;
	if (repositories.isError) return <Alert>{failureMessage(repositories.error)}</Alert>;
	return (
		<RepositoriesGroup
			repositories={repositories.data}
			available={canManage ? (available.data ?? []) : undefined}
			pending={add.isPending || remove.isPending}
			error={add.error ?? remove.error ?? available.error ?? undefined}
			onAdd={(repository) => add.mutateAsync(repository)}
			onRemove={(repository) => remove.mutate(repository)}
		/>
	);
}

export function RepositoriesGroup({
	repositories,
	available,
	pending,
	error,
	onAdd,
	onRemove,
}: {
	repositories: PodRepositories;
	/** What may be added; `undefined` for someone who can't change them. */
	available: AvailableRepositories | undefined;
	pending: boolean;
	error?: unknown;
	onAdd: (repository: PodRepository) => Promise<unknown>;
	onRemove: (repository: PodRepository) => void;
}) {
	const added = new Set(repositories.repositories.map((one) => one.repository.toLowerCase()));
	return (
		<>
			<SettingsGroup
				label="Repositories"
				note="Bots read these in the sandbox. They push only to branches starting sugabots/, and each push and pull request waits for someone in the pod to allow it."
			>
				{repositories.repositories.length === 0 && (
					<SettingsRow
						label="None yet"
						sub={
							available?.length === 0
								? "Install a GitHub App under Repositories in workspace settings first."
								: "Bots can still clone public repositories."
						}
					/>
				)}
				{repositories.repositories.map((item) => (
					<SettingsRow
						key={`${item.gitHostId}:${item.repository}`}
						label={<span className="font-mono text-[13.5px]">{item.repository}</span>}
						sub={`Added by ${item.addedByName ?? "someone who has left"}`}
						trailing={
							available && (
								<IconButton
									label={`Remove ${item.repository}`}
									disabled={pending}
									onClick={() =>
										onRemove({ gitHostId: item.gitHostId, repository: item.repository })
									}
								>
									<X size={16} />
								</IconButton>
							)
						}
					/>
				))}
				{available && available.length > 0 && (
					<AddRepositoryRow
						choices={available.filter((one) => !added.has(one.repository.toLowerCase()))}
						disabled={pending}
						onAdd={onAdd}
					/>
				)}
			</SettingsGroup>
			{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
		</>
	);
}

/** Takes a repository's name, suggesting those the workspace's apps reach. */
function AddRepositoryRow({
	choices,
	disabled,
	onAdd,
}: {
	choices: AvailableRepositories;
	disabled: boolean;
	onAdd: (repository: PodRepository) => Promise<unknown>;
}) {
	const id = useId();
	const listId = useId();
	const [draft, setDraft] = useState("");
	const chosen = choices.find((one) => one.repository.toLowerCase() === draft.trim().toLowerCase());

	function submit(event: FormEvent) {
		event.preventDefault();
		if (!chosen) return;
		void onAdd({ gitHostId: chosen.gitHostId, repository: chosen.repository }).then(() =>
			setDraft(""),
		);
	}

	return (
		<form onSubmit={submit}>
			<SettingsControlRow label="Add" htmlFor={id}>
				<input
					id={id}
					type="text"
					list={listId}
					autoComplete="off"
					spellCheck={false}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder="owner/name"
					className="min-w-0 flex-1 bg-transparent font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
				<datalist id={listId}>
					{choices.map((one) => (
						<option key={`${one.gitHostId}:${one.repository}`} value={one.repository}>
							{one.private ? "Private" : "Public"}
						</option>
					))}
				</datalist>
				<button
					type="submit"
					disabled={disabled || !chosen}
					className="focus-ring shrink-0 rounded-md font-medium text-link text-sm disabled:opacity-50"
				>
					Add
				</button>
			</SettingsControlRow>
		</form>
	);
}

import { Lock, Trash2 } from "lucide-react";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import {
	useAvailableRepositories,
	useGithubConnection,
	usePodRepositories,
	usePodRepositoryActions,
} from "@/lib/github.ts";
import { Alert } from "@/ui/alert.tsx";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxField,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
} from "@/ui/combobox.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/*
 * The repositories this pod's agents may check out in its sandbox, with the
 * workspace's GitHub connection for private ones. They are picked from what
 * the connection can reach, an app's installed repositories or a token's, and
 * checked with GitHub as they are added, which is where each one's default
 * branch comes from.
 */
export function PodRepositoriesSettings({
	podId,
	canManage,
}: {
	podId: string;
	canManage: boolean;
}) {
	const repositories = usePodRepositories(podId);
	const connection = useGithubConnection();
	const actions = usePodRepositoryActions(podId);
	const available = useAvailableRepositories(podId, canManage && Boolean(connection.data));
	const [error, setError] = useState<string>();

	if (repositories.isPending) return null;
	if (repositories.isError) return <Alert>{failureMessage(repositories.error)}</Alert>;

	async function add(fullName: string) {
		setError(undefined);
		try {
			await actions.add.mutateAsync({ fullName });
		} catch (cause) {
			setError(failureMessage(cause));
		}
	}

	return (
		<section aria-label="Repositories" className="flex max-w-3xl flex-col gap-5">
			<header>
				<h2 className="font-semibold text-heading text-lg">Repositories</h2>
				<p className="text-muted-foreground text-sm">
					What this pod's agents can check out in its sandbox. Each thread works in its own
					directory, on its own branch.
				</p>
			</header>
			{connection.data === null && (
				<Alert>
					Connect GitHub in the workspace's settings first, so private repositories can be checked
					out.
				</Alert>
			)}
			{repositories.data.length > 0 ? (
				<ul className="flex flex-col divide-y divide-border-subtle rounded-2xl border border-border bg-card">
					{repositories.data.map((repository) => (
						<li key={repository.id} className="flex min-h-11 items-center gap-3 px-4 py-2">
							<span className="min-w-0 flex-1 truncate font-medium font-mono text-heading text-sm">
								{repository.fullName}
							</span>
							{repository.private && (
								<Lock aria-label="Private" size={14} className="text-muted-foreground" />
							)}
							<code className="text-muted-foreground text-xs">{repository.defaultBranch}</code>
							{canManage && (
								<IconButton
									label={`Remove ${repository.fullName}`}
									onClick={() => actions.remove.mutate(repository.id)}
									disabled={actions.remove.isPending}
								>
									<Trash2 />
								</IconButton>
							)}
						</li>
					))}
				</ul>
			) : (
				<p className="text-muted-foreground text-sm">No repositories yet.</p>
			)}
			{canManage && connection.data && (
				<RepositoryPicker
					repositories={available.data?.map((repository) => repository.fullName) ?? []}
					loading={available.isPending}
					failed={available.isError ? failureMessage(available.error) : undefined}
					disabled={actions.add.isPending}
					viaApp={connection.data.method === "app"}
					pick={(fullName) => void add(fullName)}
				/>
			)}
			{error && <Alert>{error}</Alert>}
		</section>
	);
}

/*
 * Search what the connection can reach and pick one to add. An app only
 * reaches the repositories it was installed on, so the way to offer another
 * is on GitHub, which the empty state says.
 */
function RepositoryPicker({
	repositories,
	loading,
	failed,
	disabled,
	viaApp,
	pick,
}: {
	repositories: string[];
	loading: boolean;
	failed?: string;
	disabled: boolean;
	viaApp: boolean;
	pick: (fullName: string) => void;
}) {
	if (failed) return <Alert>{failed}</Alert>;
	return (
		<Combobox
			items={repositories}
			value={null}
			onValueChange={(chosen) => {
				if (typeof chosen === "string") pick(chosen);
			}}
			disabled={disabled || loading}
		>
			<ComboboxField>
				<ComboboxInput
					aria-label="Add a repository"
					className="font-mono"
					placeholder={loading ? "Finding repositories…" : "Add a repository"}
				/>
				<ComboboxTrigger aria-label="Show repositories" />
			</ComboboxField>
			<ComboboxContent>
				<ComboboxEmpty>
					{viaApp
						? "No repositories left to add. To offer others, change the app's repositories in the workspace's GitHub settings."
						: "No repositories left that the token can reach."}
				</ComboboxEmpty>
				<ComboboxList>
					{(fullName: string) => (
						<ComboboxItem key={fullName} value={fullName}>
							<span className="font-mono">{fullName}</span>
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}

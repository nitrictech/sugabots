import { Trash2 } from "lucide-react";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import {
	useAvailableRepositories,
	useGithubConnection,
	usePodRepositories,
	usePodRepositoryActions,
} from "@/lib/github.ts";
import { Alert } from "@/ui/alert.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsControlRow, SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";

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
		<SettingsGroup
			label="Repositories"
			note={
				connection.data === null
					? "Connect GitHub in the workspace's settings first, so private repositories can be checked out."
					: "What this pod's bots can check out in its sandbox. Each thread works in its own directory, on its own branch."
			}
		>
			{repositories.data.map((repository) => (
				<SettingsRow
					key={repository.id}
					label={<span className="font-mono text-[13.5px]">{repository.fullName}</span>}
					sub={
						repository.private ? `Private · ${repository.defaultBranch}` : repository.defaultBranch
					}
					trailing={
						canManage && (
							<IconButton
								label={`Remove ${repository.fullName}`}
								onClick={() => actions.remove.mutate(repository.id)}
								disabled={actions.remove.isPending}
							>
								<Trash2 />
							</IconButton>
						)
					}
				/>
			))}
			{repositories.data.length === 0 && <SettingsRow label="No repositories yet" />}
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
			{error && (
				<div className="px-4 py-3">
					<Alert>{error}</Alert>
				</div>
			)}
		</SettingsGroup>
	);
}

/** How many matches the picker lists at once; typing narrows the rest. */
const SHOWN_MATCHES = 8;

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
	const [query, setQuery] = useState("");
	if (failed) {
		return (
			<div className="px-4 py-3">
				<Alert>{failed}</Alert>
			</div>
		);
	}
	const needle = query.trim().toLowerCase();
	const matches = repositories.filter((fullName) => fullName.toLowerCase().includes(needle));
	return (
		<>
			<SettingsControlRow label="Add">
				<input
					aria-label="Add a repository"
					autoComplete="off"
					spellCheck={false}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={loading ? "Finding repositories…" : "Search repositories"}
					disabled={disabled || loading}
					className="min-w-0 flex-1 bg-transparent font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
			</SettingsControlRow>
			{!loading && matches.length === 0 && (
				<SettingsRow
					label={
						viaApp
							? "No repositories left to add. To offer others, change the app's repositories in the workspace's GitHub settings."
							: "No repositories left that the token can reach."
					}
				/>
			)}
			{needle !== "" &&
				matches.slice(0, SHOWN_MATCHES).map((fullName) => (
					<SettingsRow
						key={fullName}
						label={<span className="font-mono text-[13.5px]">{fullName}</span>}
						onClick={
							disabled
								? undefined
								: () => {
										pick(fullName);
										setQuery("");
									}
						}
					/>
				))}
		</>
	);
}

import { Lock, Trash2 } from "lucide-react";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useGithubConnection, usePodRepositories, usePodRepositoryActions } from "@/lib/github.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";

/*
 * The repositories this pod's agents may check out in its sandbox, with the
 * workspace's GitHub token for private ones. Each is checked with GitHub as
 * it is added, which is also where its default branch comes from.
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
	const [fullName, setFullName] = useState("");
	const [error, setError] = useState<string>();

	if (repositories.isPending) return null;
	if (repositories.isError) return <Alert>{failureMessage(repositories.error)}</Alert>;

	async function add() {
		setError(undefined);
		try {
			await actions.add.mutateAsync({ fullName: fullName.trim() });
			setFullName("");
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
			{canManage && (
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (fullName.trim()) void add();
					}}
				>
					<Input
						aria-label="Repository"
						className="min-w-0 flex-1 font-mono"
						value={fullName}
						onChange={(event) => setFullName(event.target.value)}
						placeholder="owner/repository"
						disabled={actions.add.isPending}
					/>
					<Button type="submit" disabled={!fullName.trim() || actions.add.isPending}>
						Add repository
					</Button>
				</form>
			)}
			{error && <Alert>{error}</Alert>}
		</section>
	);
}

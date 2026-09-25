import type { GithubConnection } from "@sugabots/contracts";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useGithubConnection, useGithubConnectionActions } from "@/lib/github.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Input } from "@/ui/input.tsx";

/*
 * How the workspace's agents reach GitHub: a token for now, pasted once. It is
 * never shown again, and never given to a sandbox; a sandbox's git fetches
 * from its pod's repositories have it added on the way out. Which
 * repositories a pod has is set in that pod's settings.
 */
export function GithubSettings() {
	const connection = useGithubConnection();
	if (connection.isPending) return null;
	if (connection.isError) return <Alert>{failureMessage(connection.error)}</Alert>;
	return <GithubCard connection={connection.data} />;
}

function GithubCard({ connection }: { connection: GithubConnection | null }) {
	const actions = useGithubConnectionActions();
	const [token, setToken] = useState("");
	const [replacing, setReplacing] = useState(false);
	const [error, setError] = useState<string>();
	const pending =
		actions.replace.isPending ||
		actions.update.isPending ||
		actions.test.isPending ||
		actions.remove.isPending;
	const editing = replacing || !connection;

	async function act(work: () => Promise<unknown>) {
		setError(undefined);
		try {
			await work();
		} catch (cause) {
			setError(failureMessage(cause));
		}
	}

	return (
		<section
			aria-label="GitHub"
			className="flex max-w-2xl flex-col gap-4 rounded-2xl border border-border bg-card px-5 py-4"
		>
			<div>
				<h3 className="font-semibold text-heading text-lg">GitHub</h3>
				<p className="text-muted-foreground text-sm">
					Lets agents check out the repositories you add to their pods, private ones included. Use a
					fine-grained personal access token with read access to those repositories' contents.
				</p>
			</div>
			{editing ? (
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (!token) return;
						void act(async () => {
							await (connection
								? actions.update.mutateAsync({ token })
								: actions.replace.mutateAsync({ method: "token", token }));
							setToken("");
							setReplacing(false);
							await actions.test.mutateAsync();
						});
					}}
				>
					<Input
						aria-label="GitHub token"
						className="min-w-0 flex-1 font-mono"
						type="password"
						autoComplete="off"
						value={token}
						onChange={(event) => setToken(event.target.value)}
						placeholder="github_pat_…"
						disabled={pending}
					/>
					<Button type="submit" disabled={!token || pending}>
						Save token
					</Button>
					{connection && (
						<Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
							Cancel
						</Button>
					)}
				</form>
			) : (
				<div className="flex flex-wrap items-center gap-3 text-sm">
					<span className="text-foreground">{standing(connection, actions.test.data)}</span>
					<Button size="bare" variant="link" onClick={() => setReplacing(true)}>
						Replace token
					</Button>
					<span aria-hidden className="text-muted-foreground">
						·
					</span>
					<Button
						size="bare"
						variant="link"
						disabled={pending}
						onClick={() => act(() => actions.test.mutateAsync())}
					>
						Test
					</Button>
					<span aria-hidden className="text-muted-foreground">
						·
					</span>
					<Button
						size="bare"
						variant="link"
						disabled={pending}
						onClick={() => act(() => actions.remove.mutateAsync())}
					>
						Disconnect
					</Button>
				</div>
			)}
			{error && <Alert>{error}</Alert>}
		</section>
	);
}

function standing(
	connection: GithubConnection,
	latest: { reachable: boolean; login?: string; error?: string } | undefined,
): string {
	if (latest) {
		return latest.reachable
			? `Connected as ${latest.login}.`
			: (latest.error ?? "GitHub didn't accept it.");
	}
	if (connection.status === "connected") return `Connected as ${connection.accountLogin}.`;
	if (connection.status === "error") return connection.lastTestError ?? "The last test failed.";
	return "Token saved, not tested yet.";
}

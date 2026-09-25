import type { GithubConnection } from "@sugabots/contracts";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useGithubConnectionActions, useGithubSetup } from "@/lib/github.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { Input } from "@/ui/input.tsx";

/*
 * How the workspace's agents reach GitHub. The recommended way is a GitHub App
 * of the workspace's own: registered in one step through GitHub's manifest
 * flow, installed on the account or organisation that holds the repositories,
 * and minting short-lived tokens narrowed to each job. A personal access
 * token is the fallback. Neither is ever given to a sandbox. Which
 * repositories a pod has is set in that pod's settings.
 */
export function GithubSettings() {
	const setup = useGithubSetup();
	if (setup.isPending) return null;
	if (setup.isError) return <Alert>{failureMessage(setup.error)}</Alert>;
	return <GithubCard connection={setup.data.connection} installUrl={setup.data.installUrl} />;
}

/** What GitHub or the way back from it said went wrong, carried in the page's address. */
function returnedError(): string | undefined {
	return new URLSearchParams(window.location.search).get("github_error") ?? undefined;
}

function GithubCard({
	connection,
	installUrl,
}: {
	connection: GithubConnection | null;
	installUrl: string | null;
}) {
	const actions = useGithubConnectionActions();
	const [error, setError] = useState<string | undefined>(returnedError);
	const [choosingToken, setChoosingToken] = useState(false);
	const pending =
		actions.replace.isPending ||
		actions.update.isPending ||
		actions.test.isPending ||
		actions.remove.isPending ||
		actions.startApp.isPending;

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
					Lets agents check out the repositories you add to their pods, private ones included, and
					push branches and open pull requests when someone approves.
				</p>
			</div>
			{connection === null && !choosingToken && (
				<CreateApp
					pending={pending}
					create={(organization) =>
						act(async () => {
							const { actionUrl, manifest } = await actions.startApp.mutateAsync(organization);
							postManifest(actionUrl, manifest);
						})
					}
					useToken={() => setChoosingToken(true)}
				/>
			)}
			{(choosingToken || connection?.method === "token") && (
				<TokenConnection
					connection={connection}
					pending={pending}
					save={(token) =>
						act(async () => {
							await (connection
								? actions.update.mutateAsync({ token })
								: actions.replace.mutateAsync({ method: "token", token }));
							setChoosingToken(false);
							await actions.test.mutateAsync();
						})
					}
					cancel={connection ? undefined : () => setChoosingToken(false)}
				/>
			)}
			{connection?.method === "app" && (
				<AppConnection connection={connection} installUrl={installUrl} />
			)}
			{connection && (
				<div className="flex flex-wrap items-center gap-3 text-sm">
					<span className="text-foreground">{standing(connection, actions.test.data)}</span>
					{connection.installed && (
						<Button
							size="bare"
							variant="link"
							disabled={pending}
							onClick={() => act(() => actions.test.mutateAsync())}
						>
							Test
						</Button>
					)}
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

function CreateApp({
	pending,
	create,
	useToken,
}: {
	pending: boolean;
	create: (organization: string) => void;
	useToken: () => void;
}) {
	const [organization, setOrganization] = useState("");
	return (
		<div className="flex flex-col gap-3">
			<p className="m-0 text-sm">
				Create a GitHub App for this workspace. GitHub asks you to confirm it, then to choose which
				repositories it can reach. Sugabots keeps its key and never gives it to a sandbox.
			</p>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					create(organization.trim());
				}}
			>
				<Input
					aria-label="GitHub organisation"
					className="min-w-0 flex-1"
					value={organization}
					onChange={(event) => setOrganization(event.target.value)}
					placeholder="Organisation (leave empty for your own account)"
					disabled={pending}
				/>
				<Button type="submit" disabled={pending}>
					Create GitHub App
				</Button>
			</form>
			<Button size="bare" variant="link" className="self-start" onClick={useToken}>
				Use a personal access token instead
			</Button>
		</div>
	);
}

function AppConnection({
	connection,
	installUrl,
}: {
	connection: GithubConnection;
	installUrl: string | null;
}) {
	return (
		<div className="flex flex-col gap-2 text-sm">
			<p className="m-0">
				App <code className="text-xs">{connection.appSlug}</code>
				{connection.installed && connection.accountLogin
					? `, installed on ${connection.accountLogin}.`
					: ", not installed yet."}
			</p>
			{installUrl && (
				<a
					href={installUrl}
					className={buttonStyles({
						variant: connection.installed ? "secondary" : "default",
						className: "self-start",
					})}
				>
					{connection.installed ? "Change repositories on GitHub" : "Install on GitHub"}
				</a>
			)}
		</div>
	);
}

function TokenConnection({
	connection,
	pending,
	save,
	cancel,
}: {
	connection: GithubConnection | null;
	pending: boolean;
	save: (token: string) => void;
	cancel?: () => void;
}) {
	const [token, setToken] = useState("");
	const [replacing, setReplacing] = useState(false);
	if (connection && !replacing) {
		return (
			<Button size="bare" variant="link" className="self-start" onClick={() => setReplacing(true)}>
				Replace token
			</Button>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			<p className="m-0 text-muted-foreground text-sm">
				A fine-grained personal access token with contents and pull requests access to the
				repositories.
			</p>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (!token) return;
					save(token);
					setToken("");
					setReplacing(false);
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
				{(cancel || replacing) && (
					<Button
						type="button"
						variant="ghost"
						onClick={() => (replacing ? setReplacing(false) : cancel?.())}
					>
						Cancel
					</Button>
				)}
			</form>
		</div>
	);
}

/**
 * GitHub's manifest flow starts with a form post from the browser, so this
 * builds the form GitHub expects and submits it, leaving the page for GitHub.
 */
function postManifest(actionUrl: string, manifest: string) {
	const form = document.createElement("form");
	form.method = "post";
	form.action = actionUrl;
	const field = document.createElement("input");
	field.type = "hidden";
	field.name = "manifest";
	field.value = manifest;
	form.append(field);
	document.body.append(form);
	form.submit();
}

function standing(
	connection: GithubConnection,
	latest: { reachable: boolean; login?: string; error?: string } | undefined,
): string {
	if (!connection.installed) return "Waiting for the app to be installed.";
	if (latest) {
		return latest.reachable
			? `Connected as ${latest.login}.`
			: (latest.error ?? "GitHub didn't accept it.");
	}
	if (connection.status === "connected") {
		return connection.method === "app"
			? "Connected through the app."
			: `Connected as ${connection.accountLogin}.`;
	}
	if (connection.status === "error") return connection.lastTestError ?? "The last test failed.";
	return "Saved, not tested yet.";
}

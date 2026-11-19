import { BookOpen, Lock, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import {
	useConnectionRepositories,
	useMakeGitHubApp,
	usePrefetchReachableRepositories,
	useReachableRepositories,
} from "@/lib/github-connections.ts";
import { Alert } from "@/ui/alert.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DialogFormBody,
	DialogFormFooter,
	DialogFormFrame,
	DialogFormHeader,
	DialogFormStep,
} from "@/ui/dialog-form.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SearchField, useSearchFilter } from "@/ui/search-field.tsx";
import {
	SettingsAddRow,
	SettingsControlRow,
	SettingsGroup,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";

/**
 * Connecting a project to GitHub: the project gets a private GitHub App of its
 * own, made on GitHub from Sugabots' manifest, owned by the organization named
 * or by the person, then installed there; its repositories are chosen on its
 * page once it is. A project connects to one account, since its computer can be
 * signed in to only one at GitHub.
 */
export function GitHubConnectStep({
	projectId,
	onBack,
	done,
}: {
	projectId: string;
	onBack: () => void;
	done: () => void;
}) {
	const id = useId();
	const make = useMakeGitHubApp(projectId);
	const [organization, setOrganization] = useState("");

	function submit(event: FormEvent) {
		event.preventDefault();
		make.mutate(organization.trim() || undefined);
	}

	return (
		<DialogFormStep onSubmit={submit}>
			<DialogFormHeader title="GitHub" onBack={onBack} backDisabled={make.isPending} />
			<DialogFormBody>
				<div className="flex flex-col items-center gap-1.5 pb-1 text-center">
					<ConnectionMark presetId="github" name="GitHub" />
					<span className="text-xs text-muted-foreground">
						The project gets a private GitHub App of its own: you make it on GitHub, then install it
						on the account it works on.
					</span>
				</div>
				<SettingsGroup note="The organization whose repositories the project works on. Leave it empty for your own account. Making an app for an organization takes an owner or app manager there.">
					<SettingsControlRow label="Organization" htmlFor={id}>
						<input
							id={id}
							type="text"
							autoComplete="off"
							spellCheck={false}
							value={organization}
							onChange={(event) => setOrganization(event.target.value)}
							placeholder="Optional"
							className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
						/>
					</SettingsControlRow>
				</SettingsGroup>
				{make.error && <Alert>{failureMessage(make.error)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter
				onCancel={done}
				cancelDisabled={make.isPending}
				action="Make on GitHub"
				actionDisabled={make.isPending}
			/>
		</DialogFormStep>
	);
}

/**
 * A GitHub connection's repositories, on its page: who added each, and, for
 * someone who manages the project's connections, removing one or adding another
 * the connection's app reaches. Nothing until the app is installed.
 */
export function GitHubRepositoriesGroup({
	projectId,
	connectionId,
	appSettingsUrl,
	canManage,
}: {
	projectId: string;
	connectionId: string;
	/** Where the app's owner changes it on GitHub. */
	appSettingsUrl: string;
	canManage: boolean;
}) {
	const { repositories, add, remove } = useConnectionRepositories(projectId, connectionId);
	// Listing what the app reaches takes GitHub a while, so it starts before Add repository is chosen.
	usePrefetchReachableRepositories(
		projectId,
		connectionId,
		canManage && !!repositories.data?.account,
	);
	const [choosing, setChoosing] = useState(false);
	if (repositories.isPending) return null;
	if (repositories.isError) return <Alert>{failureMessage(repositories.error)}</Alert>;
	const { account, repositories: listed } = repositories.data;
	if (!account) return null;
	return (
		<>
			<SettingsGroup
				label="Repositories"
				// On the connection's page, straight under the page's own heading.
				headingLevel={2}
				note={
					<>
						The project's bots read these from its computer, and work on them with the tools below.
						They come from {account} on GitHub, through{" "}
						<a
							href={appSettingsUrl}
							target="_blank"
							rel="noreferrer"
							className="focus-ring rounded-sm font-medium text-link"
						>
							the project's app
						</a>
						.
					</>
				}
			>
				{listed.length === 0 && <SettingsRow label="None yet" />}
				{listed.map((item) => (
					<SettingsRow
						key={item.repository}
						label={<span className="font-mono text-xs">{item.repository}</span>}
						sub={`Added by ${item.addedByName ?? "someone who has left"}`}
						trailing={
							canManage && (
								<IconButton
									label={`Remove ${item.repository}`}
									disabled={remove.isPending}
									onClick={() => remove.mutate(item.repository)}
								>
									<X size={16} />
								</IconButton>
							)
						}
					/>
				))}
				{canManage && <SettingsAddRow label="Add repository" onClick={() => setChoosing(true)} />}
			</SettingsGroup>
			{(add.error ?? remove.error) && <Alert>{failureMessage(add.error ?? remove.error)}</Alert>}
			<Dialog open={choosing} onOpenChange={setChoosing}>
				{choosing && (
					<AddRepositoryDialog
						projectId={projectId}
						connectionId={connectionId}
						account={account}
						accountRepositories={listed.map((one) => one.repository.toLowerCase())}
						onAdd={(repository) => add.mutateAsync(repository)}
						done={() => setChoosing(false)}
					/>
				)}
			</Dialog>
		</>
	);
}

/** Adding one of the repositories the connection's app reaches that the connection doesn't have yet. */
function AddRepositoryDialog({
	projectId,
	connectionId,
	account,
	accountRepositories,
	onAdd,
	done,
}: {
	projectId: string;
	connectionId: string;
	account: string;
	/** The connection's repositories, lowercased, which aren't offered again. */
	accountRepositories: readonly string[];
	onAdd: (repository: string) => Promise<unknown>;
	done: () => void;
}) {
	const reached = useReachableRepositories(projectId, connectionId);
	const [adding, setAdding] = useState<string>();
	const [error, setError] = useState<unknown>();
	const addable = (reached.data ?? []).filter(
		(one) => !accountRepositories.includes(one.repository.toLowerCase()),
	);
	const {
		query,
		setQuery,
		searching,
		matches: shown,
	} = useSearchFilter(addable, (one) => [one.repository]);

	async function addOne(repository: string) {
		setAdding(repository);
		setError(undefined);
		try {
			await onAdd(repository);
			done();
		} catch (cause) {
			setError(cause);
			setAdding(undefined);
		}
	}

	return (
		<DialogFormFrame>
			<DialogFormStep onSubmit={(event) => event.preventDefault()}>
				<DialogFormHeader title={`Add from ${account}`} />
				<DialogFormBody>
					<SearchField label="Search repositories" value={query} onChange={setQuery} />
					{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
					{reached.error && <Alert>{failureMessage(reached.error)}</Alert>}
					<div className="-mx-1 max-h-repos overflow-y-auto px-1 max-md:max-h-none max-md:overflow-visible">
						{shown.length > 0 ? (
							<SettingsGroup>
								{shown.map((choice) => (
									<SettingsRow
										key={choice.repository}
										icon={choice.private ? <Lock size={14} /> : <BookOpen size={14} />}
										label={<span className="font-mono text-xs">{choice.repository}</span>}
										sub={choice.private ? "Private" : "Public"}
										trailing={
											adding === choice.repository ? (
												<SettingsValue>Adding…</SettingsValue>
											) : undefined
										}
										onClick={
											adding === undefined ? () => void addOne(choice.repository) : undefined
										}
									/>
								))}
							</SettingsGroup>
						) : reached.isPending ? (
							<p className="m-0 px-1 text-muted-foreground text-xs">
								Finding the repositories the app reaches…
							</p>
						) : (
							!reached.isError && (
								<p className="m-0 px-1 text-muted-foreground text-xs">
									{!searching
										? `The connection has every repository the app reaches on ${account}.`
										: `No repository matches “${query.trim()}”.`}
								</p>
							)
						)}
					</div>
				</DialogFormBody>
				<DialogFormFooter onCancel={done} cancelDisabled={adding !== undefined} />
			</DialogFormStep>
		</DialogFormFrame>
	);
}

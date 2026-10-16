import { BookOpen, Lock, Search, X } from "lucide-react";
import { type FormEvent, useDeferredValue, useId, useState } from "react";
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
import {
	SettingsAddRow,
	SettingsControlRow,
	SettingsGroup,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";

/**
 * Connecting a pod to GitHub: the pod gets a private GitHub App of its own,
 * made on GitHub from Sugabots' manifest, owned by the organization named or
 * by the person, then installed there; its repositories are chosen on its
 * page once it is. A pod connects to one account, since its sandbox can be
 * signed in to only one at GitHub.
 */
export function GitHubConnectStep({
	podId,
	onBack,
	done,
}: {
	podId: string;
	onBack: () => void;
	done: () => void;
}) {
	const id = useId();
	const make = useMakeGitHubApp(podId);
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
					<span className="text-[13.5px] text-muted-foreground">
						The pod gets a private GitHub App of its own: you make it on GitHub, then install it on
						the account it works on.
					</span>
				</div>
				<SettingsGroup note="The organization whose repositories the pod works on. Leave it empty for your own account. Making an app for an organization takes an owner or app manager there.">
					<SettingsControlRow label="Organization" htmlFor={id}>
						<input
							id={id}
							type="text"
							autoComplete="off"
							spellCheck={false}
							value={organization}
							onChange={(event) => setOrganization(event.target.value)}
							placeholder="Optional"
							className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
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
 * someone who manages the pod's connections, removing one or adding another
 * the connection's app reaches. Nothing until the app is installed.
 */
export function GitHubRepositoriesGroup({
	podId,
	connectionId,
	appSettingsUrl,
	canManage,
}: {
	podId: string;
	connectionId: string;
	/** Where the app's owner changes it on GitHub. */
	appSettingsUrl: string;
	canManage: boolean;
}) {
	const { repositories, add, remove } = useConnectionRepositories(podId, connectionId);
	// Listing what the app reaches takes GitHub a while, so it starts before Add repository is chosen.
	usePrefetchReachableRepositories(podId, connectionId, canManage && !!repositories.data?.account);
	const [choosing, setChoosing] = useState(false);
	if (repositories.isPending) return null;
	if (repositories.isError) return <Alert>{failureMessage(repositories.error)}</Alert>;
	const { account, repositories: listed } = repositories.data;
	if (!account) return null;
	return (
		<>
			<SettingsGroup
				label="Repositories"
				note={
					<>
						Bots in this pod read these from its sandbox, and work on them with the tools below.
						They come from {account} on GitHub, through{" "}
						<a
							href={appSettingsUrl}
							target="_blank"
							rel="noreferrer"
							className="focus-ring rounded-sm font-medium text-link"
						>
							the pod's app
						</a>
						.
					</>
				}
			>
				{listed.length === 0 && <SettingsRow label="None yet" />}
				{listed.map((item) => (
					<SettingsRow
						key={item.repository}
						label={<span className="font-mono text-[13.5px]">{item.repository}</span>}
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
						podId={podId}
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
	podId,
	connectionId,
	account,
	accountRepositories,
	onAdd,
	done,
}: {
	podId: string;
	connectionId: string;
	account: string;
	/** The connection's repositories, lowercased, which aren't offered again. */
	accountRepositories: readonly string[];
	onAdd: (repository: string) => Promise<unknown>;
	done: () => void;
}) {
	const reached = useReachableRepositories(podId, connectionId);
	const [query, setQuery] = useState("");
	const [adding, setAdding] = useState<string>();
	const [error, setError] = useState<unknown>();
	const needle = useDeferredValue(query.trim().toLowerCase());
	const shown = (reached.data ?? []).filter(
		(one) =>
			!accountRepositories.includes(one.repository.toLowerCase()) &&
			(needle === "" || one.repository.toLowerCase().includes(needle)),
	);

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
					<label className="focus-ring-within flex items-center gap-[9px] rounded-xl bg-chip px-3">
						<Search aria-hidden size={15} className="shrink-0 text-muted-foreground" />
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search repositories"
							aria-label="Search repositories"
							className="min-w-0 flex-1 bg-transparent py-[9px] text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
						/>
					</label>
					{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
					{reached.error && <Alert>{failureMessage(reached.error)}</Alert>}
					<div className="-mx-1 max-h-[min(420px,55vh)] overflow-y-auto px-1">
						{shown.length > 0 ? (
							<SettingsGroup>
								{shown.map((choice) => (
									<SettingsRow
										key={choice.repository}
										icon={choice.private ? <Lock size={14} /> : <BookOpen size={14} />}
										label={<span className="font-mono text-[13.5px]">{choice.repository}</span>}
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
							<p className="m-0 px-1 text-muted-foreground text-sm">
								Finding the repositories the app reaches…
							</p>
						) : (
							!reached.isError && (
								<p className="m-0 px-1 text-muted-foreground text-sm">
									{needle === ""
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

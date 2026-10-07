import type { GitHost } from "@sugabots/contracts";
import { GitBranch, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useGitHosts } from "@/lib/git-hosts.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import {
	SettingsControlRow,
	SettingsGroup,
	SettingsRow,
	SettingsRowIcon,
} from "@/ui/settings-page.tsx";

/**
 * Where the workspace keeps code: its GitHub Apps. Each is the workspace's
 * own, made on GitHub from Sugabots' manifest and installed on an account or
 * organization; pods then pick repositories it reaches.
 */
export function GitHostsSection() {
	const { hosts, makeGitHubApp, install, remove } = useGitHosts();
	if (hosts.isPending) return null;
	if (hosts.isError) return <Alert>{failureMessage(hosts.error)}</Alert>;
	return (
		<GitHostsGroup
			hosts={hosts.data}
			pending={makeGitHubApp.isPending || install.isPending}
			error={makeGitHubApp.error ?? install.error ?? undefined}
			onMake={(organization) => makeGitHubApp.mutate(organization)}
			onInstall={(gitHostId) => install.mutate(gitHostId)}
			onRemove={(gitHostId) => remove.mutateAsync(gitHostId)}
		/>
	);
}

export function GitHostsGroup({
	hosts,
	pending,
	error,
	onMake,
	onInstall,
	onRemove,
}: {
	hosts: readonly GitHost[];
	pending: boolean;
	error?: unknown;
	/** Leaves for GitHub to make an app owned by `organization`, or by the person. */
	onMake: (organization: string | undefined) => void;
	onInstall: (gitHostId: string) => void;
	onRemove: (gitHostId: string) => Promise<unknown>;
}) {
	const [removing, setRemoving] = useState<GitHost>();
	const [removeError, setRemoveError] = useState<string>();
	return (
		<>
			<SettingsGroup
				label="GitHub"
				note="The workspace makes its own GitHub App, which you install on your account or an organization. Each pod then picks repositories it reaches in the pod's settings, under Repositories. Bots read them in the sandbox, and push branches and open pull requests once someone in the pod allows it."
			>
				{hosts.map((host) => (
					<SettingsRow
						key={host.id}
						icon={
							<SettingsRowIcon>
								<GitBranch size={15} />
							</SettingsRowIcon>
						}
						label={host.name}
						sub={host.account ? `Installed on ${host.account}` : "Not installed yet"}
						trailing={
							<span className="flex items-center gap-2">
								{host.account ? (
									<a
										href={host.settingsUrl}
										target="_blank"
										rel="noreferrer"
										className="focus-ring shrink-0 rounded-md font-medium text-link text-sm"
									>
										On GitHub
									</a>
								) : (
									<Button size="sm" disabled={pending} onClick={() => onInstall(host.id)}>
										Install
									</Button>
								)}
								<IconButton label={`Remove ${host.name}`} onClick={() => setRemoving(host)}>
									<X size={16} />
								</IconButton>
							</span>
						}
					/>
				))}
				<NewAppRow disabled={pending} onMake={onMake} />
			</SettingsGroup>
			{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
			<DeleteDialog
				open={removing !== undefined}
				onOpenChange={(open) => {
					if (open) return;
					setRemoving(undefined);
					setRemoveError(undefined);
				}}
				title={`Remove ${removing?.name ?? "the app"}?`}
				description="Pods lose its repositories, and bots can't read or push to them. The app stays on GitHub until you delete it there."
				confirmLabel="Remove"
				pending={false}
				error={removeError}
				onDelete={async () => {
					if (!removing) return;
					try {
						await onRemove(removing.id);
						setRemoving(undefined);
					} catch (cause) {
						setRemoveError(failureMessage(cause));
					}
				}}
			/>
		</>
	);
}

/** Makes a new app: for an organization when one is named, otherwise for the person's own account. */
function NewAppRow({
	disabled,
	onMake,
}: {
	disabled: boolean;
	onMake: (organization: string | undefined) => void;
}) {
	const id = useId();
	const [organization, setOrganization] = useState("");

	function submit(event: FormEvent) {
		event.preventDefault();
		onMake(organization.trim() || undefined);
	}

	return (
		<form onSubmit={submit}>
			<SettingsControlRow label="New app" htmlFor={id}>
				<input
					id={id}
					type="text"
					autoComplete="off"
					spellCheck={false}
					value={organization}
					onChange={(event) => setOrganization(event.target.value)}
					placeholder="Organization (optional)"
					className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
				<button
					type="submit"
					disabled={disabled}
					className="focus-ring shrink-0 rounded-md font-medium text-link text-sm disabled:opacity-50"
				>
					Make on GitHub
				</button>
			</SettingsControlRow>
		</form>
	);
}

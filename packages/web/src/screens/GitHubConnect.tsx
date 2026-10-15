import { type FormEvent, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useMakeGitHubApp } from "@/lib/github-connections.ts";
import { Alert } from "@/ui/alert.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import {
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
	DialogFormStep,
} from "@/ui/dialog-form.tsx";
import { SettingsControlRow, SettingsGroup } from "@/ui/settings-page.tsx";

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

import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useReloadUnreachedSites } from "@/lib/desktop.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useAddPodSandboxHosts } from "@/lib/pod-sandbox.ts";
import { Alert } from "@/ui/alert.tsx";
import { Checkbox } from "@/ui/checkbox.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { ScrollArea } from "@/ui/scroll-area.tsx";
import { HostName } from "./SandboxNetworkSettings.tsx";

/**
 * The sites the pages in an agent's browser tried and failed to reach, each
 * to allow for the pod or not, then the pages that failed on them loaded
 * again. The sites come from inside the sandbox, which a bot or a page can
 * steer, so every one is named, and the list stays as it was when the dialog
 * opened, whatever the pages do meanwhile.
 */
export function AllowUnreachedSitesDialog({
	threadId,
	agentId,
	agentName,
	podId,
	podName,
	hosts,
	onDone,
}: {
	threadId: string;
	agentId: string;
	agentName: string;
	podId: string;
	podName: string;
	/** The sites the pod may allow, as they stood when the dialog was opened. */
	hosts: readonly string[];
	onDone: () => void;
}) {
	const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(hosts));
	const addHosts = useAddPodSandboxHosts(podId);
	const reload = useReloadUnreachedSites(threadId, agentId);
	const allow = useMutation({
		mutationFn: async (allowed: readonly string[]) => {
			await addHosts.mutateAsync(allowed);
			await reload.mutateAsync(allowed);
		},
		onSuccess: onDone,
	});
	const allowed = hosts.filter((host) => chosen.has(host));

	function submit(event: FormEvent) {
		event.preventDefault();
		if (allowed.length > 0) allow.mutate(allowed);
	}

	function choose(host: string, on: boolean) {
		setChosen((before) => {
			const after = new Set(before);
			if (on) after.add(host);
			else after.delete(host);
			return after;
		});
	}

	const rows = hosts.map((host) => (
		// biome-ignore lint/a11y/noLabelWithoutControl: Base UI's checkbox renders a button inside the label.
		<label
			key={host}
			className="flex cursor-pointer items-center gap-3 border-border border-b px-4 py-3 last:border-b-0"
		>
			<Checkbox
				checked={chosen.has(host)}
				onCheckedChange={(on) => choose(host, on)}
				disabled={allow.isPending}
			/>
			<HostName host={host} />
		</label>
	));

	return (
		<DialogForm width="compact" onSubmit={submit}>
			<DialogFormHeader title={`Allow sites for ${podName}`} />
			<DialogFormBody>
				<p className="m-0 text-muted-foreground text-sm">
					Pages in {agentName}'s browser tried to reach these sites. Every bot in the {podName} pod
					will be able to reach the ones you allow.
				</p>
				<div className="overflow-hidden rounded-panel bg-list">
					{hosts.length > SITES_BEFORE_SCROLLING ? (
						<ScrollArea className="h-72">{rows}</ScrollArea>
					) : (
						rows
					)}
				</div>
				{allow.error && <Alert>{failureMessage(allow.error)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter
				action={`Allow ${allowed.length === 1 ? "1 site" : `${allowed.length} sites`}`}
				actionDisabled={allow.isPending || allowed.length === 0}
				cancelDisabled={allow.isPending}
			/>
		</DialogForm>
	);
}

const SITES_BEFORE_SCROLLING = 6;

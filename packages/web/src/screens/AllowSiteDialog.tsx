import { sandboxHostSchema, sandboxHostToAllowSchema } from "@sugabots/contracts";
import { Schema } from "effect";
import { type FormEvent, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useAddPodSandboxHosts } from "@/lib/pod-sandbox.ts";
import { Alert } from "@/ui/alert.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
	DialogFormInput,
} from "@/ui/dialog-form.tsx";

/**
 * Lets the pod's sandbox reach a site, for a person using its desktop who
 * found one it can't. They type the site as they know it, or paste its
 * address, and it is allowed with its subdomains, so `google.com` also lets
 * in `www.google.com`, where its pages are: both together, or neither.
 */
export function AllowSiteDialog({ podId, onDone }: { podId: string; onDone: () => void }) {
	const addHosts = useAddPodSandboxHosts(podId);
	const [text, setText] = useState("");
	const fieldId = useId();
	const site = siteName(text);
	const refusal = site ? whyNotAllowable(site) : undefined;

	function submit(event: FormEvent) {
		event.preventDefault();
		if (!site || refusal) return;
		addHosts.mutate([site, `*.${site}`], { onSuccess: onDone });
	}

	return (
		<DialogForm width="compact" onSubmit={submit}>
			<DialogFormHeader title="Allow a site" />
			<DialogFormBody>
				<label htmlFor={fieldId} className="text-muted-foreground text-sm">
					Every bot in this pod will be able to reach it from its computer, along with its other
					addresses, such as www.{site || "example.com"}.
				</label>
				<DialogFormInput
					id={fieldId}
					value={text}
					onChange={(event) => setText(event.target.value)}
					placeholder="example.com"
					disabled={addHosts.isPending}
					spellCheck={false}
				/>
				{refusal && <p className="m-0 text-muted-foreground text-sm">{refusal}</p>}
				{addHosts.error && <Alert>{failureMessage(addHosts.error)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter
				action="Allow"
				actionDisabled={addHosts.isPending || !site || refusal !== undefined}
				cancelDisabled={addHosts.isPending}
			/>
		</DialogForm>
	);
}

/**
 * The site's name from what was typed: a name such as `google.com`, a pasted
 * address such as `https://www.google.com/search?q=…`, or a wildcard. A
 * leading `*.` or `www.` is dropped, since its subdomains are allowed with it.
 */
function siteName(text: string): string {
	const trimmed = text.trim().toLowerCase();
	if (!trimmed) return "";
	const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
	if (!URL.canParse(withScheme)) return "";
	return new URL(withScheme).hostname
		.replace(/\.$/, "")
		.replace(/^\*\./, "")
		.replace(/^www\./, "");
}

const isHost = Schema.is(sandboxHostSchema);
const isHostToAllow = Schema.is(sandboxHostToAllowSchema);

/** Why the sandbox can't be let into `site` and its subdomains, which the API would refuse too. */
function whyNotAllowable(site: string): string | undefined {
	if (!isHost(site)) {
		return "Enter a site's name, such as example.com. Addresses on your own network can't be allowed.";
	}
	if (!isHostToAllow(`*.${site}`)) {
		return `Anyone can make sites under ${site}, so enter the one you mean, such as yourname.${site}.`;
	}
	return undefined;
}

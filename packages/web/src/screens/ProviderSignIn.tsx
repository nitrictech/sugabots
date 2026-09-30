import {
	type ModelProvider,
	type ProviderSignInStarted,
	providerPreset,
	type SignInServiceId,
	signInServiceNames,
} from "@sugabots/contracts";
import { ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useProviderActions } from "@/lib/model-providers.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { CopyIconButton } from "@/ui/copy-icon-button.tsx";
import { Dialog, DialogDescription } from "@/ui/dialog.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { ConnectionRow, valueText } from "./connection-row.tsx";

/**
 * A subscription provider's credential, in place of a key: the person signs
 * in on the service's site by entering a code shown here, as with Codex CLI's
 * or Grok Build's headless sign-in, while the page asks the server whether they
 * have finished.
 */
export function ProviderSignInRow({
	provider,
	service,
	signOutBlocked,
}: {
	provider: ModelProvider;
	service: SignInServiceId;
	/** Why signing out is not allowed yet; the button is disabled while there is a reason. */
	signOutBlocked?: string;
}) {
	const actions = useProviderActions();
	const [started, setStarted] = useState<ProviderSignInStarted>();
	const [error, setError] = useState<string>();
	const [warning, setWarning] = useState(false);

	async function start() {
		setWarning(false);
		setError(undefined);
		try {
			setStarted(await actions.startSignIn.mutateAsync({ providerId: provider.id }));
		} catch (cause) {
			setError(failureMessage(cause));
		}
	}

	const shownError =
		error ?? (actions.signOut.error ? failureMessage(actions.signOut.error) : undefined);

	return (
		<>
			{started ? (
				<SignInCode
					providerId={provider.id}
					service={service}
					started={started}
					onFinished={(failure) => {
						setStarted(undefined);
						setError(failure);
					}}
				/>
			) : (
				<ConnectionRow
					label="Account"
					action={
						provider.signedIn ? (
							<Button
								variant="ghost"
								size="bare"
								className="text-sm"
								disabled={actions.signOut.isPending || signOutBlocked !== undefined}
								title={signOutBlocked}
								onClick={() => actions.signOut.mutate({ providerId: provider.id })}
							>
								Sign out
							</Button>
						) : (
							<Button
								variant="link"
								size="bare"
								className="text-sm"
								disabled={actions.startSignIn.isPending}
								onClick={() => setWarning(true)}
							>
								Sign in with {signInServiceNames[service]}
							</Button>
						)
					}
				>
					<span className={valueText}>{provider.signedIn ? "Signed in" : "Not signed in"}</span>
				</ConnectionRow>
			)}
			{shownError && (
				<div className="border-border border-b px-4 py-3 last:border-b-0">
					<Alert>{shownError}</Alert>
				</div>
			)}
			<Dialog open={warning} onOpenChange={setWarning}>
				{warning && (
					<SingleUserWarning
						plan={provider.preset ? providerPreset(provider.preset).name : provider.name}
						service={service}
						onContinue={start}
					/>
				)}
			</Dialog>
		</>
	);
}

/** Where each service's terms say an account may not be shared. */
const ACCOUNT_SHARING_TERMS: Record<SignInServiceId, { owner: string; url: string }> = {
	chatgpt: {
		owner: "OpenAI",
		url: "https://openai.com/policies/terms-of-use/#registration-and-access",
	},
	xai: { owner: "xAI", url: "https://x.ai/legal/terms-of-service" },
};

/**
 * Said before anyone signs in: a subscription is one person's, and every bot
 * in the workspace would run on it.
 */
function SingleUserWarning({
	plan,
	service,
	onContinue,
}: {
	/** The subscription, as the page names it: "ChatGPT", "SuperGrok". */
	plan: string;
	service: SignInServiceId;
	onContinue: () => void;
}) {
	const terms = ACCOUNT_SHARING_TERMS[service];
	return (
		<DialogForm
			width="compact"
			onSubmit={(event) => {
				event.preventDefault();
				onContinue();
			}}
		>
			<DialogFormHeader title="Single-user installs only" />
			<DialogFormBody>
				<DialogDescription className="m-0 flex gap-2.5 text-md text-muted-foreground">
					<TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
					<span>
						A {plan} plan is for one person. Only connect yours if nobody else uses this Sugabots
						install. See{" "}
						<a href={terms.url} target="_blank" rel="noreferrer" className="text-link">
							{terms.owner}'s terms
						</a>
						.
					</span>
				</DialogDescription>
			</DialogFormBody>
			<DialogFormFooter action="Sign in" />
		</DialogForm>
	);
}

/** The code to enter, shown until the person has entered it, the code expires, or they give up. */
function SignInCode({
	providerId,
	service,
	started,
	onFinished,
}: {
	providerId: string;
	service: SignInServiceId;
	started: ProviderSignInStarted;
	/** With a sentence to show when the sign-in did not work out. */
	onFinished: (failure?: string) => void;
}) {
	const { mutateAsync: complete } = useProviderActions().completeSignIn;
	// Read through a ref so a parent re-render does not restart the polling.
	const finished = useRef(onFinished);
	finished.current = onFinished;

	useEffect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const ask = async () => {
			try {
				const outcome = await complete({ providerId, attempt: started.attempt });
				if (stopped) return;
				if (outcome.status === "signed_in") return finished.current();
				timer = setTimeout(ask, started.pollIntervalMs);
			} catch (cause) {
				if (!stopped) finished.current(failureMessage(cause));
			}
		};
		timer = setTimeout(ask, started.pollIntervalMs);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [complete, providerId, started]);

	return (
		<div className="flex flex-col gap-3 border-border border-b px-4 py-3 last:border-b-0">
			<p className="m-0 text-[14px] text-muted-foreground">
				Open {signInServiceNames[service]}'s sign-in page and enter this code. This page carries on
				once you have.
			</p>
			<div className="flex flex-wrap items-center gap-3">
				<span className="inline-flex items-center gap-1 rounded-lg bg-chip py-1 pr-1 pl-3">
					<code className="font-mono text-foreground text-xl tracking-widest">
						{started.userCode}
					</code>
					<CopyIconButton label="Copy code" text={started.userCode} />
				</span>
				<a
					href={started.verificationUrl}
					target="_blank"
					rel="noreferrer"
					className={buttonStyles({ variant: "secondary", size: "sm" })}
				>
					<ExternalLink aria-hidden /> Open sign-in page
				</a>
				<span className="flex-1" />
				<RefreshCw aria-hidden className="size-4 animate-spin text-muted-foreground" />
				<Button variant="ghost" size="sm" onClick={() => finished.current()}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

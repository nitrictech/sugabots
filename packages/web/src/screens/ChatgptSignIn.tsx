import type { ChatgptSignInStarted, ModelProvider } from "@sugabots/contracts";
import { Check, Copy, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useProviderActions } from "@/lib/model-providers.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { Dialog, DialogDescription } from "@/ui/dialog.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ConnectionRow, valueText } from "./connection-row.tsx";

/**
 * A ChatGPT provider's credential, in place of a key: the person signs in on
 * OpenAI's site by entering a code shown here, as with Codex CLI's headless
 * sign-in, while the page asks the server whether they have finished.
 */
export function ChatgptSignInRow({
	provider,
	signOutBlocked,
}: {
	provider: ModelProvider;
	/** Why signing out is not allowed yet; the button is disabled while there is a reason. */
	signOutBlocked?: string;
}) {
	const actions = useProviderActions();
	const [started, setStarted] = useState<ChatgptSignInStarted>();
	const [error, setError] = useState<string>();
	const [warning, setWarning] = useState(false);

	async function start() {
		setWarning(false);
		setError(undefined);
		try {
			setStarted(await actions.startChatgptSignIn.mutateAsync({ providerId: provider.id }));
		} catch (cause) {
			setError(failureMessage(cause));
		}
	}

	const shownError =
		error ??
		(actions.signOutChatgpt.error ? failureMessage(actions.signOutChatgpt.error) : undefined);

	return (
		<>
			{started ? (
				<ChatgptSignInCode
					providerId={provider.id}
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
								disabled={actions.signOutChatgpt.isPending || signOutBlocked !== undefined}
								title={signOutBlocked}
								onClick={() => actions.signOutChatgpt.mutate({ providerId: provider.id })}
							>
								Sign out
							</Button>
						) : (
							<Button
								variant="link"
								size="bare"
								className="text-sm"
								disabled={actions.startChatgptSignIn.isPending}
								onClick={() => setWarning(true)}
							>
								Sign in with ChatGPT
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
				{warning && <SingleUserWarning onContinue={start} />}
			</Dialog>
		</>
	);
}

/** Where OpenAI's terms say an account may not be shared. */
const OPENAI_ACCOUNT_SHARING_TERMS =
	"https://openai.com/policies/terms-of-use/#registration-and-access";

/**
 * Said before anyone signs in: a ChatGPT plan is one person's, and every bot
 * in the workspace would run on it.
 */
function SingleUserWarning({ onContinue }: { onContinue: () => void }) {
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
						A ChatGPT plan is for one person. Only connect yours if nobody else uses this Sugabots
						install. See{" "}
						<a
							href={OPENAI_ACCOUNT_SHARING_TERMS}
							target="_blank"
							rel="noreferrer"
							className="text-link"
						>
							OpenAI's terms
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
function ChatgptSignInCode({
	providerId,
	started,
	onFinished,
}: {
	providerId: string;
	started: ChatgptSignInStarted;
	/** With a sentence to show when the sign-in did not work out. */
	onFinished: (failure?: string) => void;
}) {
	const { mutateAsync: complete } = useProviderActions().completeChatgptSignIn;
	const [copied, setCopied] = useState(false);
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
				Open ChatGPT's sign-in page and enter this code. This page carries on once you have.
			</p>
			<div className="flex flex-wrap items-center gap-3">
				<span className="inline-flex items-center gap-1 rounded-lg bg-chip py-1 pr-1 pl-3">
					<code className="font-mono text-foreground text-xl tracking-widest">
						{started.userCode}
					</code>
					<IconButton
						label={copied ? "Copied" : "Copy code"}
						onClick={() => {
							void navigator.clipboard?.writeText(started.userCode);
							setCopied(true);
						}}
					>
						{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
					</IconButton>
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

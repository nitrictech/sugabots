import type { ChatgptSignInStarted, ModelProvider } from "@sugabots/contracts";
import { Check, Copy, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useProviderActions } from "@/lib/model-providers.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { Dialog, DialogClose, DialogDescription, DialogTitle } from "@/ui/dialog.tsx";
import { DialogForm, DialogFormBody, DialogFormFooter } from "@/ui/dialog-form.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SurfaceHeader, SurfaceTitle } from "@/ui/surface.tsx";
import { useTestConnection } from "./ProviderConnection.tsx";

/**
 * A ChatGPT provider's credential: the person signs in on OpenAI's site by
 * entering a code shown here, as with Codex CLI's headless sign-in, while the
 * page asks the server whether they have finished.
 */
export function ChatgptSignIn({ provider }: { provider: ModelProvider }) {
	const actions = useProviderActions();
	const test = useTestConnection(provider);
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

	const signOutError = actions.signOutChatgpt.error
		? failureMessage(actions.signOutChatgpt.error)
		: undefined;
	const shownError = error ?? signOutError ?? test.error;

	return (
		<>
			<div className="flex flex-col gap-3 rounded-xl border border-border px-4 py-4 sm:flex-row sm:items-center sm:px-5">
				{provider.signedIn ? (
					<>
						<span className="text-sm text-foreground">Signed in with ChatGPT</span>
						<Button
							size="bare"
							variant="link"
							className="text-sm"
							disabled={actions.signOutChatgpt.isPending}
							onClick={() => actions.signOutChatgpt.mutate({ providerId: provider.id })}
						>
							Sign out
						</Button>
						<span className="flex-1" />
						{test.button}
					</>
				) : started ? (
					<ChatgptSignInCode
						providerId={provider.id}
						started={started}
						onFinished={(failure) => {
							setStarted(undefined);
							setError(failure);
						}}
					/>
				) : (
					<>
						<span className="text-sm text-foreground">Use the models on your ChatGPT plan.</span>
						<span className="flex-1" />
						<Button
							onClick={() => setWarning(true)}
							disabled={actions.startChatgptSignIn.isPending}
						>
							Sign in with ChatGPT
						</Button>
					</>
				)}
			</div>
			{shownError && <Alert className="mt-2">{shownError}</Alert>}
			<SingleUserWarning open={warning} onOpenChange={setWarning} onContinue={start} />
		</>
	);
}

/** Where OpenAI's terms say an account may not be shared. */
const OPENAI_ACCOUNT_SHARING_TERMS =
	"https://openai.com/policies/terms-of-use/#registration-and-access";

/**
 * Said before anyone signs in: a ChatGPT plan is one person's, and every agent
 * in the workspace would run on it.
 */
function SingleUserWarning({
	open,
	onOpenChange,
	onContinue,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onContinue: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogForm
				onSubmit={(event) => {
					event.preventDefault();
					onContinue();
				}}
			>
				<SurfaceHeader>
					<SurfaceTitle
						title={
							<DialogTitle className="flex items-center gap-2">
								<TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
								For single-user installs only
							</DialogTitle>
						}
					/>
				</SurfaceHeader>
				<DialogFormBody>
					<DialogDescription className="m-0 text-base text-muted-foreground">
						A ChatGPT plan is for one person. Only connect yours if nobody else uses this Sugabots
						install. See{" "}
						<a href={OPENAI_ACCOUNT_SHARING_TERMS} target="_blank" rel="noreferrer">
							OpenAI's terms
						</a>
						.
					</DialogDescription>
				</DialogFormBody>
				<DialogFormFooter>
					<DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
					<Button type="submit">I understand, sign in</Button>
				</DialogFormFooter>
			</DialogForm>
		</Dialog>
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
		<div className="flex min-w-0 flex-1 flex-col gap-3">
			<p className="text-sm text-muted-foreground">
				Open ChatGPT's sign-in page and enter this code. This page carries on once you have.
			</p>
			<div className="flex flex-wrap items-center gap-3">
				<span className="inline-flex items-center gap-1 rounded-md bg-muted py-1 pr-1 pl-3">
					<code className="font-mono text-xl tracking-widest text-foreground">
						{started.userCode}
					</code>
					<IconButton
						label={copied ? "Copied" : "Copy code"}
						size="sm"
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
					className={buttonStyles({ variant: "secondary" })}
				>
					<ExternalLink /> Open sign-in page
				</a>
				<span className="flex-1" />
				<RefreshCw className="size-4 animate-spin text-muted-foreground" aria-hidden />
				<Button variant="ghost" onClick={() => finished.current()}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

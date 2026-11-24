import { Button, buttonStyles } from "@/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog.tsx";

/*
 * Asking before a link leads off the app. A link written by a bot need not go
 * where its words say, and one written under a prompt injection can carry
 * data out in its address. So a plain click on such a link asks first, and
 * shows the whole address. A link in a message (`MarkdownLink`) and a link in
 * a document's text (`LiveDocumentText`) each decide which clicks ask, and
 * both ask with this dialog.
 */

/** What the dialog says before a link off the app opens. */
export interface LeavingWording {
	title: string;
	description: string;
	open: string;
}

export const LINK_WORDING: LeavingWording = {
	title: "Open external link?",
	description: "You're about to visit a website outside Sugabots.",
	open: "Open link",
};

/** Whether `href` leads somewhere in the app, which a link opens without asking. */
export function isInApp(href: string): boolean {
	return URL.parse(href, window.location.href)?.origin === window.location.origin;
}

/**
 * LeavingDialog asks before `href`, off the app, opens. It says `wording`,
 * shows the whole address, and has a link that opens it in a new tab.
 */
export function LeavingDialog({
	href,
	wording,
	open,
	onOpenChange,
}: {
	href: string;
	wording: LeavingWording;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent sheetOnPhone>
				<div className="flex flex-col gap-1.5">
					<DialogTitle>{wording.title}</DialogTitle>
					<DialogDescription>{wording.description}</DialogDescription>
				</div>
				<p className="break-all rounded-md bg-chip p-2.5 font-mono text-xs">{href}</p>
				<div className="flex justify-end gap-2">
					<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<a
						href={href}
						target="_blank"
						rel="noreferrer"
						className={buttonStyles({ size: "sm" })}
						onClick={() => onOpenChange(false)}
					>
						{wording.open}
					</a>
				</div>
			</DialogContent>
		</Dialog>
	);
}

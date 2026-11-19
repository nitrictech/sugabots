import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/ui/button.tsx";

/**
 * The centred card the pages outside the shell sit on: log in, accept an
 * invitation, set a workspace up. There is no sidebar to be had on any of them
 * — you are not in a workspace yet — so they get their own frame.
 */
export function AuthLayout({
	title,
	subtitle,
	onBack,
	children,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	/** A way back to the page before, such as the welcome. */
	onBack?: () => void;
	children: ReactNode;
}) {
	return (
		<div className="flex h-full flex-col overflow-auto bg-background text-foreground">
			<header className="shrink-0 px-8 pt-7 max-md:px-4">
				{onBack && <AuthBackButton onClick={onBack} />}
			</header>
			<div className="grid flex-1 place-items-center px-4 py-10">
				<div className="flex w-full max-w-110 flex-col gap-3.5">
					<div className="flex flex-col gap-2.5 pb-2">
						<AuthHeading title={title}>{subtitle}</AuthHeading>
					</div>
					{children}
				</div>
			</div>
		</div>
	);
}

/** A page's title, and the line under it, centred, as every page outside the shell opens. */
export function AuthHeading({ title, children }: { title: ReactNode; children?: ReactNode }) {
	return (
		<>
			<h1 className="m-0 text-balance text-center font-bold text-3xl leading-tight tracking-tight">
				{title}
			</h1>
			{children !== undefined && (
				<p className="m-0 text-pretty text-center text-sm text-muted-foreground leading-normal">
					{children}
				</p>
			)}
		</>
	);
}

/** Back, at a page's top left, to the page or step before. */
export function AuthBackButton({ onClick }: { onClick: () => void }) {
	return (
		<Button variant="link" size="bare" onClick={onClick} className="gap-0.5 text-sm">
			<ChevronLeft aria-hidden strokeWidth={2.4} className="size-4" />
			Back
		</Button>
	);
}

/** A quieter way on, under a form: Forgot password, Skip for now. */
export function QuietLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
	return (
		<Button variant="ghost" size="bare" onClick={onClick} className="self-center p-1.5 text-sm">
			{children}
		</Button>
	);
}

/** A field inside a `FormRow`, filling the row after its label. */
export const fieldClass =
	"min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground";

/** One labelled field in the form's card, as every form in the app lays them out. */
export function FormRow({
	id,
	label,
	children,
}: {
	id: string;
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center gap-3 border-border border-b px-4 py-3.5 last:border-b-0 focus-within:bg-panel">
			<label htmlFor={id} className="w-22 shrink-0 text-sm text-muted-foreground">
				{label}
			</label>
			{children}
		</div>
	);
}

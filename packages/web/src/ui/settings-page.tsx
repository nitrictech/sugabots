import { useRender } from "@base-ui/react/use-render";
import { cn } from "cn";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Alert } from "@/ui/alert.tsx";
import { BACK_LABEL_ON_PHONE, BACK_ON_PHONE } from "@/ui/back-button.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";

/*
 * The pieces a settings page is made of, as the design draws them: a centred
 * column with a title, groups of rows on raised cards like a phone's settings,
 * and a danger action at the foot. The same pieces serve every section, so a
 * page reads as part of one app rather than as a form of its own.
 */

/**
 * The bar at a panel's top left with its Back, padded as a list's title row
 * is, so Back lines up with the list's + beside it.
 */
const PANEL_BACK_BAR =
	"sticky top-0 z-10 flex shrink-0 items-center bg-background/90 px-4 pt-5 pb-3 backdrop-blur max-md:bg-transparent max-md:pt-[max(12px,env(safe-area-inset-top))] max-md:pb-2 max-md:backdrop-blur-none";

const PANEL_BACK_LINK =
	"focus-ring inline-flex min-h-[30px] min-w-0 items-center gap-1 rounded-md font-medium text-[14px] text-link";

const PAGE_TITLE = "m-0 font-semibold text-2xl text-foreground leading-[30px] tracking-[-0.025em]";

/** A settings page: its title and what it is for, then its groups. */
export function SettingsPage({
	title,
	description,
	hero,
	back,
	backOnWide = false,
	headerAction,
	children,
	className,
}: {
	title?: ReactNode;
	description?: ReactNode;
	/** A 44px picture beside the title, such as a bot's face or your avatar. */
	hero?: ReactNode;
	/** The link back to where this page was opened from, at the panel's top left: a `PageBackLink`. */
	back?: ReactNode;
	/**
	 * Whether `back` shows on a wide screen too, where it otherwise gives way to
	 * the trail: for a step inside another page with no address of its own,
	 * such as a bot's Instructions, which the trail can't lead back from, and
	 * for a page opened from one beside it, such as a provider from Models.
	 */
	backOnWide?: boolean;
	/** A control beside the title, such as Invite people. */
	headerAction?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<>
			{back && (
				// Marked, so the settings frame leaves out its own Back beside this one.
				<div
					data-page-back=""
					// On a wide screen it fits in the room above every page's title (8 + 30
					// of the 40), so the title doesn't move between a page and one opened from it.
					className={cn(PANEL_BACK_BAR, backOnWide ? "lg:pt-2 lg:pb-0" : "lg:hidden")}
				>
					{back}
				</div>
			)}
			<div
				className={cn(
					"mx-auto flex w-full max-w-[760px] flex-col gap-8 px-4 pb-20 md:px-8",
					// Close under its Back; on a wide screen, as high as any other page.
					// On a phone every page has a Back above it, the frame's or its own.
					!back ? "pt-10 max-md:pt-3" : backOnWide ? "pt-3 lg:pt-0.5" : "pt-3 lg:pt-10",
					className,
				)}
			>
				{hero ? (
					<div className="flex flex-wrap items-center gap-x-3.5 gap-y-3">
						{/* One size of slot for every picture, so moving between pages never moves the title. */}
						<span className="grid size-11 shrink-0 place-items-center">{hero}</span>
						<div className="flex min-w-[min(100%,12rem)] flex-1 flex-col gap-0.5">
							{title && <h2 className={cn(PAGE_TITLE, "truncate")}>{title}</h2>}
							{description && (
								<p className="m-0 text-[13px] text-muted-foreground">{description}</p>
							)}
						</div>
						{headerAction && <div className="shrink-0">{headerAction}</div>}
					</div>
				) : (
					(title || description) && (
						// The actions wrap under the title when they leave it too narrow, as on a phone.
						<div className="flex flex-wrap items-start gap-x-4 gap-y-3">
							<div className="flex min-w-[min(100%,15rem)] flex-1 flex-col gap-1">
								{title && <h2 className={PAGE_TITLE}>{title}</h2>}
								{description && (
									<p className="m-0 text-pretty text-[13px] text-muted-foreground leading-normal">
										{description}
									</p>
								)}
							</div>
							{headerAction && <div className="shrink-0">{headerAction}</div>}
						</div>
					)
				)}
				{children}
			</div>
		</>
	);
}

/** The card a group's rows sit on, and anything else on a settings page drawn as one. */
export const SETTINGS_CARD =
	"overflow-hidden rounded-xl border border-settings-card-border bg-settings-card";

/** The outlined + beside a page's title that adds to it: Invite people, New bot. */
export function SettingsAddButton({
	children,
	onClick,
	disabled,
	render,
}: {
	children: ReactNode;
	onClick?: () => void;
	disabled?: boolean;
	/** The element it is, when it opens something itself, such as a menu: `render={<DropdownMenuTrigger />}`. */
	render?: useRender.RenderProp;
}) {
	return useRender({
		render,
		defaultTagName: "button",
		props: {
			type: render ? undefined : "button",
			onClick,
			disabled,
			className:
				"focus-ring flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border-strong pr-3 pl-2.5 font-medium text-[13px] text-foreground transition-colors hover:border-border-dashed hover:bg-row-hover disabled:cursor-default disabled:opacity-50",
			children: (
				<>
					<Plus aria-hidden size={14} strokeWidth={2} />
					{children}
				</>
			),
		},
	});
}

/** A named group of rows on one card, with an optional note beneath. */
export function SettingsGroup({
	label,
	description,
	note,
	action,
	headingLevel = 3,
	children,
	className,
}: {
	label?: ReactNode;
	/** A line under the label, before the rows: what the rows below have in common. */
	description?: ReactNode;
	/** A line after the rows: what follows from them. */
	note?: ReactNode;
	/** A control at the right of the label, such as Invite people. */
	action?: ReactNode;
	/** 3 under a page's title; 2 where the groups sit straight under the screen's heading. */
	headingLevel?: 2 | 3;
	children: ReactNode;
	className?: string;
}) {
	const Heading = headingLevel === 2 ? "h2" : "h3";
	const headingId = useId();
	return (
		// Named by its label, so a screen reader can move between a page's groups by name.
		<section aria-labelledby={label ? headingId : undefined} className="flex flex-col">
			{(label || action) && (
				<div className={cn("flex items-center gap-2 px-0.5", description ? "pb-1" : "pb-2.5")}>
					{label && (
						<Heading
							id={headingId}
							className="m-0 min-w-0 flex-1 font-medium text-[13px] text-muted-foreground"
						>
							{label}
						</Heading>
					)}
					{action}
				</div>
			)}
			{description && (
				<p className="m-0 text-pretty px-0.5 pb-2.5 text-subtle-foreground text-xs leading-normal">
					{description}
				</p>
			)}
			<div className={cn(SETTINGS_CARD, className)}>{children}</div>
			{note && (
				<div className="text-pretty px-0.5 pt-2.5 text-subtle-foreground text-xs leading-normal">
					{note}
				</div>
			)}
		</section>
	);
}

/** A row of a settings card, ruled off from the one below it. */
const SETTINGS_ROW =
	"flex min-h-14 items-center gap-3.5 border-border border-b px-4 last:border-b-0";

/**
 * One row of a group: an optional icon, a label and a line under it, and what
 * sits at its end (a value, a switch, a button). Given `render` or `onClick` it
 * is the whole row's action, and gets a chevron when it goes somewhere.
 */
export function SettingsRow({
	icon,
	label,
	sub,
	trailing,
	chevron = false,
	render,
	onClick,
	className,
}: {
	icon?: ReactNode;
	label: ReactNode;
	sub?: ReactNode;
	trailing?: ReactNode;
	/** Shows that the row opens something further in. */
	chevron?: boolean;
	/** The element the row is, when it is a link: `render={<Link … />}`. */
	render?: useRender.RenderProp;
	onClick?: () => void;
	className?: string;
}) {
	const interactive = render !== undefined || onClick !== undefined;
	const row = useRender({
		render,
		defaultTagName: onClick ? "button" : "div",
		props: {
			type: onClick && !render ? "button" : undefined,
			onClick,
			className: cn(
				`${SETTINGS_ROW} w-full min-w-0 py-3 text-left`,
				interactive && "focus-ring cursor-pointer transition-colors hover:bg-settings-row-hover",
				className,
			),
			children: (
				<>
					{icon}
					<span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-[1.4]">
						<span className="truncate text-[13px] text-foreground">{label}</span>
						{sub && <span className="text-pretty text-subtle-foreground text-xs">{sub}</span>}
					</span>
					{trailing}
					{chevron && (
						<ChevronRight
							aria-hidden
							size={14}
							strokeWidth={2}
							className="shrink-0 text-subtle-foreground"
						/>
					)}
				</>
			),
		},
	});
	return row;
}

/** A field in a form's group: its label on the left, the input filling the rest of the row. */
export function SettingsFieldRow({
	label,
	value,
	onChange,
	placeholder,
	maxLength,
	mono = false,
	secret = false,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	maxLength?: number;
	/** For addresses, keys and header names. */
	mono?: boolean;
	secret?: boolean;
}) {
	const id = useId();
	return (
		<SettingsControlRow label={label} htmlFor={id}>
			<input
				id={id}
				type={secret ? "password" : "text"}
				autoComplete={secret ? "new-password" : "off"}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				maxLength={maxLength}
				className={cn(
					"min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-subtle-foreground",
					mono && "font-mono",
				)}
			/>
		</SettingsControlRow>
	);
}

/**
 * A name, edited in place, which saves trimmed when you leave it or press
 * Enter. Escape, or leaving it blank or unchanged, puts the name back; so does
 * a save that fails, and `error` says why under it.
 */
export function SettingsNameRow({
	name,
	maxLength,
	savePending,
	error,
	onCommit,
}: {
	name: string;
	maxLength: number;
	savePending: boolean;
	error: string | undefined;
	onCommit: (name: string) => Promise<unknown>;
}) {
	const [draft, setDraft] = useState(name);
	const id = useId();

	function commit() {
		const next = draft.trim();
		if (savePending || next === name || next === "") {
			setDraft(name);
			return;
		}
		setDraft(next);
		void onCommit(next).catch(() => setDraft(name));
	}

	return (
		<>
			<SettingsControlRow label="Name" htmlFor={id}>
				<input
					id={id}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
						if (event.key === "Escape") setDraft(name);
					}}
					maxLength={maxLength}
					className="-ml-2.5 h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2.5 text-[13px] text-foreground outline-none hover:border-border-strong focus-visible:border-ring focus-visible:bg-settings-row-hover"
				/>
			</SettingsControlRow>
			{error && (
				<Alert className="border-border border-b px-4 py-2.5 text-[13px] last:border-b-0">
					{error}
				</Alert>
			)}
		</>
	);
}

/**
 * A field row whose control is not a text input, such as a colour picker,
 * laid out as a `SettingsFieldRow` so the two line up in one form.
 */
export function SettingsControlRow({
	label,
	htmlFor,
	stackOnPhone = false,
	children,
}: {
	label: string;
	/** The control's id, when it is one a label can name. */
	htmlFor?: string;
	/**
	 * Whether, on a phone, the control goes on a line of its own under the
	 * label, across the row's width: for a grid of choices that beside the
	 * label would be too small to tap.
	 */
	stackOnPhone?: boolean;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				SETTINGS_ROW,
				"py-2.5",
				stackOnPhone && "max-sm:flex-col max-sm:items-stretch max-sm:gap-2",
			)}
		>
			<SettingsFieldLabel htmlFor={htmlFor}>{label}</SettingsFieldLabel>
			{children}
		</div>
	);
}

/**
 * A field row whose control is a pick-one row of options, such as Schedule /
 * Webhook. On a phone the options go on a line of their own under the label,
 * across the row's width, so a long row of them is never cut off.
 */
export function SettingsChoiceRow<Value extends string>({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: readonly { value: Value; label: string }[];
	value: Value | undefined;
	onChange: (value: Value) => void;
}) {
	return (
		<div className={cn(SETTINGS_ROW, "py-2.5 max-sm:flex-col max-sm:items-stretch max-sm:gap-2")}>
			<SettingsFieldLabel>{label}</SettingsFieldLabel>
			<SegmentedControl
				label={label}
				options={options}
				value={value}
				onChange={onChange}
				className="sm:ml-auto max-sm:w-full max-sm:[&>label]:flex-1 max-sm:[&>label]:text-center"
			/>
		</div>
	);
}

/**
 * A field row's label on its own, for a row that is itself the control, such
 * as a button that opens a list. Given `htmlFor` it labels that control;
 * without it, it is only text, for a control that names itself.
 */
export function SettingsFieldLabel({
	htmlFor,
	children,
}: {
	htmlFor?: string;
	children: ReactNode;
}) {
	const className = "min-w-24 shrink-0 whitespace-nowrap text-[13px] text-foreground";
	return htmlFor ? (
		<label htmlFor={htmlFor} className={className}>
			{children}
		</label>
	) : (
		<span className={className}>{children}</span>
	);
}

/** The value at a row's end, in the muted colour. */
export function SettingsValue({ children }: { children: ReactNode }) {
	return (
		<span className="shrink-0 whitespace-nowrap text-[13px] text-muted-foreground">{children}</span>
	);
}

/** An outlined button at a row's end, for the one thing the row offers: Connect, Replace. */
export function SettingsRowButton({
	children,
	onClick,
	disabled,
}: {
	children: ReactNode;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="focus-ring h-[30px] shrink-0 whitespace-nowrap rounded-lg border border-border-strong px-3 text-[13px] text-foreground transition-colors hover:bg-row-hover disabled:cursor-default disabled:opacity-50"
		>
			{children}
		</button>
	);
}

/** The round mark at the end of a pick-one row, filled for the one picked. */
export function SettingsRadioMark({ checked }: { checked: boolean }) {
	return (
		<span
			aria-hidden
			className={cn(
				"grid size-4 shrink-0 place-items-center rounded-full border",
				checked ? "border-foreground" : "border-border-dashed",
			)}
		>
			{checked && <span className="size-2 rounded-full bg-foreground" />}
		</span>
	);
}

/** A pick-one row's look, for a `<label>` around a hidden radio: the row lifts under the pointer and rings when focused. */
export const SETTINGS_RADIO_ROW =
	"flex min-h-14 cursor-pointer items-center gap-3.5 border-border border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-settings-row-hover has-focus-visible:shadow-(--ring-shadow) has-disabled:cursor-default";

/** How a Test went, as a dot and a line cut short to fit, given whole when pointed at. */
export function SettingsTestOutcome({ good, children }: { good: boolean; children: string }) {
	return (
		<span
			role={good ? "status" : "alert"}
			title={children}
			className={cn(
				"flex min-w-0 items-center gap-1.5 text-xs",
				good ? "text-muted-foreground" : "text-destructive-text",
			)}
		>
			<span
				aria-hidden
				className={cn("size-1.5 shrink-0 rounded-full", good ? "bg-success" : "bg-destructive")}
			/>
			<span className="truncate">{children}</span>
		</span>
	);
}

/** A row's state as a small green pill with a dot, for something working: Connected. */
export function SettingsStatusBadge({ children }: { children: ReactNode }) {
	return (
		<span className="flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-success/12 px-2 font-medium text-success-text text-xs">
			<span aria-hidden className="size-1.5 rounded-full bg-success" />
			{children}
		</span>
	);
}

/** A 28px square that stands for what a row is about: an app's letters, an icon. */
export function SettingsRowIcon({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			aria-hidden
			className={cn(
				"grid size-7 shrink-0 place-items-center rounded-[7px] border border-border-strong font-semibold text-soft-foreground text-xs",
				className,
			)}
		>
			{children}
		</span>
	);
}

/** A row that adds to its group, such as New bot: a square with a plus, and what it adds, quieter than the rows above it. */
export function SettingsAddRow({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				SETTINGS_ROW,
				"focus-ring w-full border-t py-3 text-left transition-colors first:border-t-0 hover:bg-settings-row-hover",
			)}
		>
			<SettingsAddMark />
			<span className="text-[13px] text-muted-foreground">{label}</span>
		</button>
	);
}

/** The square with a plus that marks a row adding to its group. */
export function SettingsAddMark() {
	return (
		<SettingsRowIcon>
			<Plus size={14} strokeWidth={2} />
		</SettingsRowIcon>
	);
}

/** The foot of a page for something that cannot be undone: Delete pod, Sign out. */
export function SettingsDanger({
	label,
	description,
	action,
	onClick,
	disabledReason,
}: {
	/** What the action does, in full: Delete pod. */
	label: string;
	/** What follows from it: Removes its bots, threads and artifacts. */
	description: ReactNode;
	/** The button's own word, short beside the label: Delete. */
	action: string;
	onClick: () => void;
	/** Why it cannot be done yet, in place of the description; the action is disabled while there is one. */
	disabledReason?: string;
}) {
	return (
		<div
			className={cn(
				SETTINGS_CARD,
				"flex min-h-14 flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3",
			)}
		>
			<div className="flex min-w-[min(100%,12rem)] flex-1 flex-col gap-0.5 leading-[1.4]">
				<span className="text-[13px] text-foreground">{label}</span>
				<span className="text-pretty text-subtle-foreground text-xs">
					{disabledReason ?? description}
				</span>
			</div>
			<button
				type="button"
				onClick={onClick}
				disabled={disabledReason !== undefined}
				aria-label={label}
				className="focus-ring -mr-1.5 h-[30px] shrink-0 whitespace-nowrap rounded-lg px-3 font-medium text-[13px] text-destructive-text transition-colors hover:bg-destructive-hover disabled:cursor-not-allowed disabled:opacity-50"
			>
				{action}
			</button>
		</div>
	);
}

/** Where a Back link goes and what it says, as the element it renders: `render={<Link … />}`. */
export interface BackTarget {
	label: string;
	render: useRender.RenderProp;
}

/** The small Back link above a page's title, for `SettingsPage`'s `back`; a phone's round Back there. */
export function PageBackLink({ label, render }: BackTarget) {
	return useRender({
		render,
		props: {
			className: cn(PANEL_BACK_LINK, BACK_ON_PHONE),
			children: (
				<>
					<ChevronLeft aria-hidden size={16} strokeWidth={2.4} className="max-md:size-[22px]" />
					<span className={cn("min-w-0 truncate", BACK_LABEL_ON_PHONE)}>{label}</span>
				</>
			),
		},
	});
}

/**
 * The bar across the top of a page on a narrow screen, with its Back in the
 * larger size a tablet's is, and on a phone the round Back every page there
 * has. `className` hides it where the page is wide enough for its own:
 * `md:hidden`.
 */
export function CompactBackBar({ label, render, className }: BackTarget & { className: string }) {
	const link = useRender({
		render,
		props: {
			className: cn(
				"focus-ring inline-flex items-center gap-0.5 rounded-md font-medium text-[15px] text-link",
				BACK_ON_PHONE,
			),
			children: (
				<>
					<ChevronLeft aria-hidden size={20} strokeWidth={2.2} className="max-md:size-[22px]" />
					<span className={BACK_LABEL_ON_PHONE}>{label}</span>
				</>
			),
		},
	});
	return (
		<div
			className={cn(
				"sticky top-0 z-10 flex h-12 items-center bg-background/90 px-2.5 backdrop-blur",
				// A phone's Back floats on its own, at a page's inset, over nothing.
				"max-md:h-auto max-md:bg-transparent max-md:px-4 max-md:pt-[max(12px,env(safe-area-inset-top))] max-md:pb-2 max-md:backdrop-blur-none",
				className,
			)}
		>
			{link}
		</div>
	);
}

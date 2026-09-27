import { useRender } from "@base-ui/react/use-render";
import { cn } from "cn";
import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import { type ReactNode, useId } from "react";

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
	"sticky top-0 z-10 flex shrink-0 items-center bg-background/90 px-4 pt-5 pb-3 backdrop-blur";

const PANEL_BACK_LINK =
	"focus-ring inline-flex min-h-[30px] min-w-0 items-center gap-1 rounded-md font-medium text-[14px] text-link";

/** A settings page: its title and what it is for, then its groups. */
export function SettingsPage({
	title,
	description,
	hero,
	back,
	headerAction,
	children,
	className,
}: {
	title?: ReactNode;
	description?: ReactNode;
	/** A picture above the title, such as a bot's face or your avatar, which centres the heading. */
	hero?: ReactNode;
	/** The link back to where this page was opened from, at the panel's top left: a `PageBackLink`. */
	back?: ReactNode;
	/** A control beside the title, such as Invite people. Not shown with `hero`. */
	headerAction?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<>
			{back && (
				// Marked, so the settings frame leaves out its own Back beside this one.
				<div data-page-back="" className={PANEL_BACK_BAR}>
					{back}
				</div>
			)}
			<div
				className={cn(
					"mx-auto flex w-full max-w-[620px] flex-col gap-7 px-4 pb-12 md:px-8",
					back ? "pt-3" : "pt-9",
					className,
				)}
			>
				{hero ? (
					<div className="flex flex-col items-center gap-2.5 text-center">
						{hero}
						{title && <h2 className="m-0 pt-1 font-bold text-2xl text-foreground">{title}</h2>}
						{description && <p className="m-0 text-[14px] text-muted-foreground">{description}</p>}
					</div>
				) : (
					(title || description) && (
						<div className="flex items-end gap-4">
							<div className="flex min-w-0 flex-1 flex-col gap-1.5">
								{title && (
									<h2 className="m-0 font-bold text-[24px] text-foreground tracking-[-0.01em]">
										{title}
									</h2>
								)}
								{description && (
									<p className="m-0 text-[14px] text-muted-foreground leading-normal">
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

/** A named group of rows on one card, with an optional note beneath. */
export function SettingsGroup({
	label,
	note,
	action,
	headingLevel = 3,
	children,
	className,
}: {
	label?: ReactNode;
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
				<div className="flex items-center gap-2 px-1 pb-2">
					{label && (
						<Heading
							id={headingId}
							className="m-0 min-w-0 flex-1 font-medium text-sm text-subtle-foreground"
						>
							{label}
						</Heading>
					)}
					{action}
				</div>
			)}
			<div className={cn("overflow-hidden rounded-panel bg-list", className)}>{children}</div>
			{note && (
				<p className="m-0 px-1 pt-2 text-sm text-subtle-foreground leading-normal">{note}</p>
			)}
		</section>
	);
}

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
				"flex w-full min-w-0 items-center gap-3 border-border border-b px-4 py-3 text-left last:border-b-0",
				interactive && "focus-ring cursor-pointer transition-colors hover:bg-panel",
				className,
			),
			children: (
				<>
					{icon}
					<span className="flex min-w-0 flex-1 flex-col gap-px">
						{/* The design sets a lone label in the regular weight, and a name with a line under it in medium. */}
						<span className={cn("truncate text-[14.5px] text-foreground", sub && "font-medium")}>
							{label}
						</span>
						{sub && <span className="truncate text-muted-foreground text-sm">{sub}</span>}
					</span>
					{trailing}
					{chevron && (
						<ChevronRight
							aria-hidden
							size={15}
							strokeWidth={2.4}
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
	mono = false,
	secret = false,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	/** For addresses, keys and header names. */
	mono?: boolean;
	secret?: boolean;
}) {
	const id = useId();
	return (
		<div className="flex min-h-[46px] items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0">
			<label htmlFor={id} className="w-[88px] shrink-0 text-[14px] text-foreground">
				{label}
			</label>
			<input
				id={id}
				type={secret ? "password" : "text"}
				autoComplete="off"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				className={cn(
					"min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground",
					mono ? "font-mono text-[13.5px]" : "text-[14.5px]",
				)}
			/>
		</div>
	);
}

/** The value at a row's end, in the muted colour. */
export function SettingsValue({ children }: { children: ReactNode }) {
	return <span className="shrink-0 text-[13.5px] text-muted-foreground">{children}</span>;
}

/** A 30px square that stands for what a row is about: an app's letters, an icon. */
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
				"grid size-[30px] shrink-0 place-items-center rounded-[9px] bg-border-strong font-bold text-soft-foreground text-xs",
				className,
			)}
		>
			{children}
		</span>
	);
}

/** A row that adds to its group, such as New bot: a dashed circle with a plus, and what it adds in the link colour. */
export function SettingsAddRow({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="focus-ring flex w-full items-center gap-3 border-border border-t px-4 py-2.5 text-left transition-colors first:border-t-0 hover:bg-panel"
		>
			<SettingsAddMark />
			<span className="font-medium text-[14.5px] text-link">{label}</span>
		</button>
	);
}

/** The dashed circle with a plus that marks a row adding to its group. */
export function SettingsAddMark() {
	return (
		<span
			aria-hidden
			className="grid size-[30px] shrink-0 place-items-center rounded-full border-[1.5px] border-border-dashed border-dashed text-link"
		>
			<Plus size={14} strokeWidth={2.4} />
		</span>
	);
}

/** The foot of a page for something that cannot be undone: Delete pod, Sign out. */
export function SettingsDanger({
	children,
	onClick,
}: {
	children: ReactNode;
	onClick: () => void;
}) {
	return (
		<div className="flex justify-center">
			<button
				type="button"
				onClick={onClick}
				className="focus-ring rounded-md px-3 py-2 font-medium text-[14px] text-destructive-text transition-opacity hover:opacity-80"
			>
				{children}
			</button>
		</div>
	);
}

/**
 * A list of things beside the one that is open, as Bots and Pods are laid out.
 * On a phone they take turns: an open item covers its list.
 */
export function SettingsListDetail({
	list,
	detail,
	detailOpen,
	listLink,
	returnTo,
}: {
	list: ReactNode;
	detail: ReactNode;
	/** Whether an item is open, which on a phone hides the list. */
	detailOpen: boolean;
	/** The list's own page, which on a phone an open item goes back to when there is no `returnTo`. */
	listLink: BackTarget;
	/** The page the open item was reached from, when that is not the list beside it. */
	returnTo: BackTarget | undefined;
}) {
	return (
		<div className="flex min-h-full min-w-0 flex-1">
			<div
				className={cn(
					"flex w-[280px] shrink-0 flex-col border-border-subtle border-r max-md:w-full max-md:border-r-0",
					detailOpen && "max-md:hidden",
				)}
			>
				{list}
			</div>
			<div className={cn("group/detail min-w-0 flex-1", !detailOpen && "max-md:hidden")}>
				<CompactBackBar {...(returnTo ?? listLink)} className="md:hidden" />
				{returnTo && (
					<SettingsReturnBar
						{...returnTo}
						className="group-has-[[data-page-back]]/detail:hidden max-md:hidden"
					/>
				)}
				{detail}
			</div>
		</div>
	);
}

/** Where a Back link goes and what it says, as the element it renders: `render={<Link … />}`. */
export interface BackTarget {
	label: string;
	render: useRender.RenderProp;
}

/**
 * The bar across the top of a panel with the way back to the page you came
 * from, for a step that jumped between sections (a pod to one of its bots, a
 * chat to its bot's settings) and so left no Back of its own.
 */
export function SettingsReturnBar({
	label,
	render,
	className,
}: BackTarget & { className?: string }) {
	return (
		<div className={cn(PANEL_BACK_BAR, className)}>
			<PageBackLink label={`Back to ${label}`} render={render} />
		</div>
	);
}

/** The small Back link above a page's title, for `SettingsPage`'s `back`. */
export function PageBackLink({ label, render }: BackTarget) {
	return useRender({
		render,
		props: {
			className: PANEL_BACK_LINK,
			children: (
				<>
					<ChevronLeft aria-hidden size={16} strokeWidth={2.4} />
					<span className="min-w-0 truncate">{label}</span>
				</>
			),
		},
	});
}

/**
 * The bar across the top of a page on a narrow screen, with its Back in the
 * larger size a phone's is. `className` hides it where the page is wide enough
 * for its own: `md:hidden`.
 */
export function CompactBackBar({ label, render, className }: BackTarget & { className: string }) {
	const link = useRender({
		render,
		props: {
			className:
				"focus-ring inline-flex items-center gap-0.5 rounded-md font-medium text-[15px] text-link",
			children: (
				<>
					<ChevronLeft aria-hidden size={20} strokeWidth={2.2} />
					{label}
				</>
			),
		},
	});
	return (
		<div
			className={cn(
				"sticky top-0 z-10 flex h-12 items-center bg-background/90 px-2.5 backdrop-blur",
				className,
			)}
		>
			{link}
		</div>
	);
}

/** The list half: its title and a round +, a search over it, then its rows. */
export function SettingsListColumn({
	title,
	newLabel,
	onNew,
	search,
	onSearch,
	children,
}: {
	title: string;
	/** Names the + for assistive technology; absent with `onNew` when nothing may be added. */
	newLabel?: string;
	onNew?: () => void;
	search: string;
	onSearch: (value: string) => void;
	children: ReactNode;
}) {
	return (
		<>
			<div className="flex shrink-0 items-center gap-2.5 px-4 pt-5 pb-3">
				<h2 className="m-0 flex-1 font-bold text-[17px] text-foreground">{title}</h2>
				{onNew && (
					<button
						type="button"
						aria-label={newLabel}
						onClick={onNew}
						className="focus-ring grid size-[30px] shrink-0 place-items-center rounded-full bg-chip text-foreground transition-colors hover:bg-hover"
					>
						<Plus size={16} strokeWidth={2.4} />
					</button>
				)}
			</div>
			<div className="shrink-0 px-2 pb-2.5">
				<label className="focus-ring-within flex items-center gap-[9px] rounded-xl border border-transparent bg-chip px-2.5">
					<Search aria-hidden size={15} className="shrink-0 text-muted-foreground" />
					<input
						type="search"
						value={search}
						onChange={(event) => onSearch(event.target.value)}
						placeholder={`Search ${title.toLowerCase()}`}
						aria-label={`Search ${title.toLowerCase()}`}
						className="min-w-0 flex-1 bg-transparent py-[9px] text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
					/>
				</label>
			</div>
			<nav aria-label={`Workspace ${title.toLowerCase()}`} className="flex min-h-0 flex-1 flex-col">
				<ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto px-2 pb-3">
					{children}
				</ul>
			</nav>
		</>
	);
}

/** One row of a settings list: a picture, a name and a line under it, and whether it is the open one. */
export function SettingsListRow({
	picture,
	label,
	sub,
	selected,
	render,
}: {
	picture: ReactNode;
	label: ReactNode;
	sub?: ReactNode;
	/**
	 * `true` for the item the address names. `"wide"` for the one open only
	 * because none was chosen: open beside the list on a wide screen, and not on
	 * a phone, where the list stands alone.
	 */
	selected: boolean | "wide";
	/** The link the row is: `render={<Link … />}`. */
	render: useRender.RenderProp;
}) {
	const row = useRender({
		render,
		props: {
			"aria-current": selected === true ? "page" : undefined,
			className: cn(
				"focus-ring flex items-center gap-3 rounded-[14px] px-2.5 py-[9px] transition-colors",
				selected === true
					? "bg-row-selected"
					: selected === "wide"
						? "hover:bg-row-hover md:bg-row-selected"
						: "hover:bg-row-hover",
			),
			children: (
				<>
					{picture}
					<span className="flex min-w-0 flex-1 flex-col gap-px">
						<span className="truncate font-medium text-[14.5px] text-foreground">{label}</span>
						{sub && <span className="truncate text-muted-foreground text-sm">{sub}</span>}
					</span>
				</>
			),
		},
	});
	return <li>{row}</li>;
}

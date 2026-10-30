import { Repeat } from "lucide-react";
import { useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { SegmentedControl } from "./segmented-control.tsx";
import {
	PageBackLink,
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsRowIcon,
	SettingsValue,
} from "./settings-page.tsx";
import { Toggle } from "./toggle.tsx";

function Theme() {
	const [theme, setTheme] = useState<"dark" | "light" | "system">("dark");
	return (
		<SegmentedControl
			label="Theme"
			options={[
				{ value: "dark", label: "Dark" },
				{ value: "light", label: "Light" },
				{ value: "system", label: "System" },
			]}
			value={theme}
			onChange={setTheme}
		/>
	);
}

function Switch() {
	const [on, setOn] = useState(true);
	return <Toggle label="Advanced" checked={on} onChange={setOn} />;
}

const meta = preview.meta({
	title: "Patterns/SettingsPage",
	component: SettingsPage,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: { children: null },
});

/** Hero is a page about one thing, such as the workspace or you: its picture first, then its groups. */
export const Hero = meta.story({
	render: () => (
		<SettingsPage
			hero={
				<span className="grid size-[88px] place-items-center rounded-[26px] bg-foreground font-extrabold text-[34px] text-background">
					N
				</span>
			}
			title="Nitric"
			description="4 members"
		>
			<SettingsGroup label="Workspace">
				<SettingsRow label="Name" trailing={<SettingsValue>Nitric</SettingsValue>} />
				<SettingsRow label="Your access" trailing={<SettingsValue>Admin</SettingsValue>} />
			</SettingsGroup>
			<SettingsGroup label="Appearance">
				<SettingsRow label="Theme" trailing={<Theme />} />
			</SettingsGroup>
			<SettingsDanger
				label="Delete workspace"
				description="Removes every pod, bot and thread in Nitric."
				action="Delete"
				onClick={fn()}
			/>
		</SettingsPage>
	),
});

const opened = fn();

/** Listing is a page of things to open, each row a way in, with a note under its group. */
export const Listing = meta.story({
	render: () => (
		<SettingsPage title="Routines" description="What your bots do on a schedule, or when called.">
			<SettingsGroup label="Growth Desk" note="Routines post into the bot's chat when they run.">
				<SettingsRow
					icon={
						<SettingsRowIcon>
							<Repeat size={15} strokeWidth={2.2} />
						</SettingsRowIcon>
					}
					label="Overnight outbound"
					sub="Every day at 6:00 am"
					chevron
					onClick={opened}
				/>
				<SettingsRow
					label="Advanced"
					sub="Choose a provider for web search"
					trailing={<Switch />}
				/>
			</SettingsGroup>
		</SettingsPage>
	),
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Overnight outbound/ }));
		await expect(opened).toHaveBeenCalled();
	},
});

/**
 * A page opened from another, with its Back, beside the page it came from: on
 * a wide screen the Back sits above the title, so both titles are level and
 * moving between the pages doesn't move the title.
 */
export const OpenedFromAnother = meta.story({
	globals: { viewport: { value: "desktop", isRotated: false } },
	render: () => (
		<div className="flex">
			<div className="flex-1">
				<SettingsPage title="Models" description="What your bots think with.">
					{null}
				</SettingsPage>
			</div>
			<div className="flex-1">
				<SettingsPage
					back={<PageBackLink label="Models" render={<button type="button" />} />}
					backOnWide
					title="Default for new bots"
					description="The model a new bot starts with."
				>
					{null}
				</SettingsPage>
			</div>
		</div>
	),
	play: async ({ canvas }) => {
		const page = canvas.getByRole("heading", { name: "Models" }).getBoundingClientRect();
		const opened = canvas
			.getByRole("heading", { name: "Default for new bots" })
			.getBoundingClientRect();
		await expect(opened.top).toBe(page.top);
	},
});

import {
	type ModelProvider,
	presetSignsIn,
	providerPreset,
	seededPresets,
} from "@sugabots/contracts";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useModelProviders, useProviderActions } from "@/lib/model-providers.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { ProviderMark } from "@/ui/provider-mark.tsx";
import { SettingsRail, SettingsRailItem, SettingsSplitView } from "@/ui/settings-rail.tsx";
import { StatusDot } from "@/ui/status-dot.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { AddProvider } from "./AddModelProvider.tsx";
import { ChatgptSignIn } from "./ChatgptSignIn.tsx";
import { CredentialStrip, CustomEndpoint, LocalServerConnection } from "./ProviderConnection.tsx";
import { ModelsList } from "./ProviderModels.tsx";

/**
 * Whether agents can reach this provider at all. `active` is the switch that
 * gates it — an inactive provider's models are filtered out of every lookup
 * server-side — so it is the one thing the rail reports. How the connection
 * last tested belongs beside the button that tests it, in the detail pane.
 */
function ActiveMark({ active }: { active: boolean }) {
	return (
		<StatusDot
			on={active}
			label={active ? "On" : "Off"}
			tooltip={active ? "On: agents can use this provider" : "Off: agents cannot use this provider"}
		/>
	);
}

function ProviderRail({
	providers,
	selected,
	onSelect,
	onAdd,
}: {
	providers: readonly ModelProvider[];
	selected?: ModelProvider;
	onSelect: (id: string) => void;
	onAdd: () => void;
}) {
	return (
		<SettingsRail
			label="Model providers"
			footer={
				<Button
					variant="secondary"
					className="h-11 w-full justify-start border-dashed text-base"
					onClick={onAdd}
				>
					<Plus /> Add provider
				</Button>
			}
		>
			{providers.map((provider) => (
				<SettingsRailItem
					key={provider.id}
					selected={provider.id === selected?.id}
					onClick={() => onSelect(provider.id)}
				>
					<ProviderMark preset={provider.preset} />
					<span className="min-w-0 flex-1 truncate text-base font-medium text-foreground">
						{provider.name}
					</span>
					<ActiveMark active={provider.active} />
				</SettingsRailItem>
			))}
		</SettingsRail>
	);
}

function ProviderDetails({
	provider,
	onBack,
	onRemoved,
}: {
	provider: ModelProvider;
	onBack: () => void;
	onRemoved: () => void;
}) {
	const actions = useProviderActions();
	const actionError = actions.update.error ?? actions.remove.error;
	const preset = provider.preset === null ? null : providerPreset(provider.preset);
	const removable = provider.preset === null || !seededPresets.includes(provider.preset);
	return (
		<div className="min-w-0 p-5 sm:p-7 lg:p-10">
			<div className="mb-8 flex items-center gap-4">
				<Button
					size="icon"
					variant="ghost"
					className="lg:hidden"
					aria-label="Back to providers"
					onClick={onBack}
				>
					<ArrowLeft />
				</Button>
				<ProviderMark preset={provider.preset} large />
				<h2 className="min-w-0 flex-1 truncate font-display text-2xl font-semibold">
					{provider.name}
				</h2>
				<Toggle
					checked={provider.active}
					disabled={actions.update.isPending}
					label={`${provider.active ? "Deactivate" : "Activate"} ${provider.name}`}
					onChange={(active) =>
						actions.update.mutate({ providerId: provider.id, json: { active } })
					}
				/>
			</div>
			{actionError && <Alert className="mb-6">{failureMessage(actionError)}</Alert>}
			<div className="space-y-8">
				{presetSignsIn(provider.preset) ? (
					<ChatgptSignIn provider={provider} />
				) : preset?.hosting === "local" ? (
					<LocalServerConnection provider={provider} preset={preset} />
				) : (
					<CredentialStrip provider={provider} />
				)}
				{preset === null && <CustomEndpoint provider={provider} />}
				<ModelsList provider={provider} />
				{removable && (
					<Button
						variant="ghost"
						className="text-destructive hover:text-destructive"
						disabled={actions.remove.isPending}
						onClick={() => {
							if (!window.confirm(`Remove ${provider.name}?`)) return;
							actions.remove.mutate({ providerId: provider.id }, { onSuccess: onRemoved });
						}}
					>
						<Trash2 /> Remove provider
					</Button>
				)}
			</div>
		</div>
	);
}

/** ModelProvidersSettings loads and edits workspace providers through the query client and API. */
export function ModelProvidersSettings({
	className,
	detailScrollable,
}: {
	className?: string;
	detailScrollable?: boolean;
}) {
	const query = useModelProviders();
	const providers = query.data ?? [];
	const [selectedId, setSelectedId] = useState<string>();
	const [showDetail, setShowDetail] = useState(false);
	const [adding, setAdding] = useState(false);
	const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
	if (query.isPending)
		return <p className="p-8 text-sm text-muted-foreground">Loading providers...</p>;
	if (query.error) return <Alert className="p-8">{failureMessage(query.error)}</Alert>;
	return (
		<SettingsSplitView
			className={className}
			detailScrollable={detailScrollable}
			showDetail={showDetail}
			rail={
				<ProviderRail
					providers={providers}
					selected={adding ? undefined : selected}
					onSelect={(id) => {
						setSelectedId(id);
						setAdding(false);
						setShowDetail(true);
					}}
					onAdd={() => {
						setAdding(true);
						setShowDetail(true);
					}}
				/>
			}
			detail={
				adding ? (
					<AddProvider
						existing={providers}
						onBack={() => {
							setAdding(false);
							setShowDetail(false);
						}}
						onCreated={(id) => {
							setSelectedId(id);
							setAdding(false);
						}}
					/>
				) : selected ? (
					<ProviderDetails
						key={selected.id}
						provider={selected}
						onBack={() => setShowDetail(false)}
						onRemoved={() => {
							setSelectedId(undefined);
							setShowDetail(false);
						}}
					/>
				) : (
					<div className="grid min-h-[600px] place-items-center text-center">
						<div>
							<h2 className="font-display text-2xl font-semibold">No providers yet</h2>
							<Button className="mt-4" onClick={() => setAdding(true)}>
								<Plus /> Add provider
							</Button>
						</div>
					</div>
				)
			}
		/>
	);
}

import { useLocation, useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext } from "react";

interface ThreadPanelValue {
	summaryOpen: boolean;
	setSummaryOpen(open: boolean): void;
}

const ThreadPanelContext = createContext<ThreadPanelValue | undefined>(undefined);

export function ThreadPanelProvider({ children }: { children: ReactNode }) {
	const location = useLocation();
	const navigate = useNavigate();
	const summaryOpen = location.search.summary !== "closed";
	function setSummaryOpen(open: boolean) {
		void navigate({
			to: location.pathname,
			search: (previous) => ({ ...previous, summary: open ? undefined : "closed" }),
		});
	}
	return (
		<ThreadPanelContext.Provider value={{ summaryOpen, setSummaryOpen }}>
			{children}
		</ThreadPanelContext.Provider>
	);
}

export function useThreadPanel(): ThreadPanelValue {
	const panel = useContext(ThreadPanelContext);
	if (!panel) {
		throw new Error("useThreadPanel requires ThreadPanelProvider");
	}
	return panel;
}

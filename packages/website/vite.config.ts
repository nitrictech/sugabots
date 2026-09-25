import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	resolve: { tsconfigPaths: true },
	server: {
		// Portless passes both; see packages/web/vite.config.ts for why $HOST matters.
		port: Number(process.env.PORT) || 3000,
		host: process.env.HOST || "localhost",
		allowedHosts: ["responsibility-symphony-athletic-sofa.trycloudflare.com"],
	},
	plugins: [tailwindcss(), tanstackStart(), react()],
});

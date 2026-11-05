import { defineConfig } from "vitest/config";

// Run on their own, by the Native apps workflow, rather than as one of the
// repo's projects: the apps keep the generated files they last took, so a
// change to the web or the API doesn't wait on regenerating them.
export default defineConfig({
	test: {
		name: "codegen",
		root: import.meta.dirname,
		environment: "node",
		include: ["**/*.test.ts"],
	},
});

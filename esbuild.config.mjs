import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const mode = process.argv[2];
const prod = mode === "production";

if (mode === "demo") {
	// Standalone browser demo of the renderer with a fake vault (no Obsidian needed).
	await esbuild.build({
		entryPoints: ["demo/demo.ts"],
		bundle: true,
		format: "iife",
		target: "es2018",
		outfile: "demo/dist/demo.js",
		logLevel: "info",
	});
	process.exit(0);
}

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}

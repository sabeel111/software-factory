// Builds the web UI from source on first request (specs/09-control-ui.md R8.10).
import { resolve } from "node:path";
import { build } from "esbuild";

export interface UiBundle {
  js: string;
  css: string;
}

export const UI_ENTRY = resolve(import.meta.dirname, "../ui/main.tsx");

export async function buildUi(): Promise<UiBundle> {
  const result = await build({
    entryPoints: [UI_ENTRY],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    jsx: "automatic",
    jsxImportSource: "preact",
    minify: true,
    outdir: "out",
    logLevel: "silent",
  });
  const js = result.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
  const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
  return { js, css };
}

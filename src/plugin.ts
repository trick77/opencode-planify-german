import type { Plugin } from "@opencode-ai/plugin"
import { erstellePlanRenderTool } from "./tool.ts"

/**
 * Registriert das Tool `plan_render`. Damit ist planify über den
 * `plugin`-Eintrag in opencode.json installierbar, ohne Symlink in
 * ~/.config/opencode/tool.
 *
 * Option `openWith` überschreibt das Kommando zum Öffnen der Plan-Datei; ohne
 * Angabe gewinnt der Standard-Handler des Systems (open, xdg-open, start).
 */
export const PlanifyPlugin: Plugin = async (_input, optionen) => ({
  tool: {
    plan_render: erstellePlanRenderTool({
      openWith: typeof optionen?.openWith === "string" ? optionen.openWith : undefined,
    }),
  },
})

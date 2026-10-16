import type { Plugin } from "@opencode-ai/plugin"
import { createPlanRenderTool } from "./tool.ts"
import { createPrSummaryTool } from "./tool-pr.ts"

const stringOption = (value: unknown) => (typeof value === "string" ? value : undefined)

/**
 * Registriert die Tools `plan_render` und `pr_summary`. Damit ist planify über den
 * `plugin`-Eintrag in opencode.json installierbar, ohne Symlink in
 * ~/.config/opencode/tool.
 *
 * Optionen: `openWith` überschreibt das Kommando zum Öffnen der Plan-Datei, ohne
 * Angabe gewinnt der Standard-Handler des Systems (open, xdg-open, start).
 * `bitbucketUrl` und `bitbucketToken` braucht `pr_summary`.
 */
export const PlanifyPlugin: Plugin = async (_input, options) => ({
  tool: {
    plan_render: createPlanRenderTool({ openWith: stringOption(options?.openWith) }),
    pr_summary: createPrSummaryTool({
      bitbucketUrl: stringOption(options?.bitbucketUrl),
      bitbucketToken: stringOption(options?.bitbucketToken),
    }),
  },
})

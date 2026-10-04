import type { Plugin } from "@opencode-ai/plugin"
import { createPlanRenderTool } from "./tool.ts"
import { createPlanPrTool } from "./tool-pr.ts"

const stringOption = (value: unknown) => (typeof value === "string" ? value : undefined)

/**
 * Registriert die Tools `plan_render` und `plan_pr`. Damit ist planify über den
 * `plugin`-Eintrag in opencode.json installierbar, ohne Symlink in
 * ~/.config/opencode/tool.
 *
 * Optionen: `openWith` überschreibt das Kommando zum Öffnen der Plan-Datei, ohne
 * Angabe gewinnt der Standard-Handler des Systems (open, xdg-open, start).
 * `bitbucketUrl` und `bitbucketToken` braucht `plan_pr`.
 */
export const PlanifyPlugin: Plugin = async (_input, options) => ({
  tool: {
    plan_render: createPlanRenderTool({ openWith: stringOption(options?.openWith) }),
    plan_pr: createPlanPrTool({
      bitbucketUrl: stringOption(options?.bitbucketUrl),
      bitbucketToken: stringOption(options?.bitbucketToken),
    }),
  },
})

import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { tool } from "@opencode-ai/plugin"
import { buildOpenCommand } from "./open.ts"
import { baseName, render, validate } from "./render.ts"

const z = tool.schema

// Die verbindliche Prüfung macht ajv gegen skills/planify/schema/plan.schema.json.
// Diese zod-Form beschreibt dem Modell nur die Struktur.
const fileEntry = z.object({
  path: z.string().describe("Pfad relativ zum Projekt, z. B. src/render.ts"),
  change: z.string().describe("Was in dieser Datei passiert, ein Satz"),
})

const planShape = z.object({
  ticket: z.string().describe("Ticket-Key aus dem Branch, Muster [A-Z][A-Z0-9]+-[0-9]+"),
  slug: z.string().describe("Kurztitel in Kebab-Case, ASCII ohne Umlaute (nur für den Dateinamen)"),
  title: z.string().describe("Titel des Vorhabens, deutsch"),
  intent: z.string().describe("Ein Absatz: was gemacht wird und warum"),
  context: z
    .object({ problem: z.string(), outcome: z.string() })
    .optional()
    .describe("problem: was heute schiefgeht. outcome: Zustand nach der Umsetzung"),
  steps: z
    .array(
      z.object({
        title: z.string(),
        rationale: z.string().optional().describe("Warum der Schritt nötig ist. Nur wenn nicht offensichtlich"),
        files: z.array(fileEntry).describe("Mindestens eine Datei mit exaktem Pfad"),
        commands: z.array(z.string()).optional(),
      }),
    )
    .describe("Umsetzungsschritte in Reihenfolge"),
  verification: z
    .array(z.object({ how: z.string(), expected: z.string() }))
    .describe("Ende-zu-Ende-Prüfung: how (Kommando oder Handgriff), expected (woran man Erfolg erkennt)"),
  risks: z.array(z.object({ risk: z.string(), mitigation: z.string() })).optional(),
  openDecisions: z
    .array(z.object({ question: z.string(), recommendation: z.string(), tradeoff: z.string() }))
    .optional()
    .describe("Offene Entscheidungen des Benutzers, mit Empfehlung und Abwägung. Nie still im Text entscheiden"),
  outOfScope: z.array(z.string()).optional(),
  diagram: z
    .object({ title: z.string(), caption: z.string().optional(), svgPath: z.string() })
    .optional()
    .describe("Nur wenn ein Diagramm Struktur zeigt, die die Prosa nicht trägt. SVG per Skill diagram-design erzeugen, Pfad hier eintragen, wird inline eingebettet"),
  meta: z
    .object({
      createdAt: z.string().describe("ISO-8601 Zeitstempel"),
      model: z.string().optional(),
      branch: z.string().optional(),
      repo: z.string().optional(),
    })
    .describe("Metadaten des Plans"),
})

export type RenderToolOptions = {
  /** Öffnen-Kommando überschreiben, z. B. "firefox". Standard: Handler des Systems. */
  openWith?: string
}

/**
 * Baut das Tool `plan_render`. Als Fabrik, damit das Plugin seine Optionen
 * (etwa ein abweichendes Öffnen-Kommando) hineingeben kann.
 */
export function createPlanRenderTool(options: RenderToolOptions = {}) {
  return tool({
  description:
    "Rendert einen Plan aus JSON zu einer eigenständigen HTML-Datei und öffnet sie im Standard-Browser. " +
    "Einziger Weg, einen Plan auszugeben: nie HTML oder Markdown selbst schreiben. " +
    "Nicht schemakonform → nichts geschrieben, Feldfehler kommen zurück, korrigieren und erneut aufrufen. " +
    "Felder und Schreibregeln: Skill \"planify\".",
  args: {
    plan: planShape.describe("Vollständiger Plan. Feldnamen englisch, Inhalte deutsch"),
    outDir: z
      .string()
      .optional()
      .describe("Zielverzeichnis, Standard docs/plans im Projekt"),
    open: z.boolean().optional().describe("HTML im Standard-Browser öffnen, Standard true"),
  },
  async execute(args, context) {
    const plan = args.plan as any
    const errors = validate(plan)
    if (errors.length) {
      return [
        "Plan nicht geschrieben — Schema verletzt:",
        ...errors.map((f) => `  ${f.path || "/"}: ${f.message}`),
        "",
        "Felder korrigieren und plan_render erneut aufrufen.",
      ].join("\n")
    }

    const targetDir = resolve(context.directory, args.outDir ?? "docs/plans")
    mkdirSync(targetDir, { recursive: true })
    const name = baseName(plan)
    const jsonPath = resolve(targetDir, `${name}.plan.json`)
    const htmlPath = resolve(targetDir, `${name}.html`)

    let result
    try {
      result = render(plan, { baseDir: context.directory })
    } catch (renderError) {
      return `Plan nicht geschrieben — Rendern fehlgeschlagen: ${(renderError as Error).message}`
    }

    writeFileSync(jsonPath, JSON.stringify(plan, null, 2) + "\n", "utf8")
    writeFileSync(htmlPath, result.html, "utf8")

    const openCommand = args.open === false ? undefined : buildOpenCommand(htmlPath, options)
    if (openCommand) {
      spawn(openCommand.command, openCommand.args, { stdio: "ignore", detached: true }).unref()
    }

    context.metadata({ title: `${plan.ticket} — ${plan.title}`, metadata: { jsonPath, htmlPath } })

    const lines = [`Plan geschrieben:`, `  ${jsonPath}`, `  ${htmlPath}`]
    if (openCommand) lines.push(`Im Standard-Browser geöffnet (${openCommand.command}).`)
    else if (args.open !== false) lines.push("Kein Öffnen-Kommando für diese Plattform, Datei bitte selbst öffnen.")
    if (result.warnings.length) {
      lines.push("", "Warnungen zur Schreibweise (bitte im nächsten Zug korrigieren und neu rendern):")
      for (const w of result.warnings) lines.push(`  ${w.path}: ${w.message}`)
    }
    return lines.join("\n")
  },
  })
}

/** Standard-Instanz für den Installationsweg über das Tool-Verzeichnis. */
export const planRenderTool = createPlanRenderTool()

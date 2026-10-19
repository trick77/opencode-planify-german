import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import { buildOpenCommand } from "./open.ts"
import { baseName, render, schemaPath, validate } from "./render.ts"

// Das Eingabeschema für opencode kommt aus skills/planify/schema/plan.schema.json, der
// einzigen Quelle. Davon bleiben nur Struktur und Beschreibungen (type, properties,
// items, description) für das Modell; required, pattern, minItems und Co. fallen weg.
// opencode prüft die Eingabe vor execute und lehnt sonst mit englischer Sammelmeldung
// ab, bevor ajv die deutschen Feldfehler liefern kann.
type JsonSchema = { [key: string]: unknown }

export function loosenSchema(schema: JsonSchema): JsonSchema {
  const loose: JsonSchema = {}
  if (schema.type !== undefined) loose.type = schema.type
  if (typeof schema.description === "string") loose.description = schema.description
  if (schema.properties && typeof schema.properties === "object") {
    loose.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, JsonSchema>).map(([name, child]) => [name, loosenSchema(child)]),
    )
  }
  if (schema.items && typeof schema.items === "object") loose.items = loosenSchema(schema.items as JsonSchema)
  return loose
}

const planShape = {
  ...loosenSchema(JSON.parse(readFileSync(schemaPath, "utf8"))),
  description: "Vollständiger Plan. Feldnamen englisch, Inhalte deutsch",
}

/** Liefert pro Tool-Aufruf das Verzeichnis der Sitzung; relative Pfade gelten ab dort. */
export type DirectoryResolver = (context: ToolContext) => string | Promise<string>

type RenderInput = { plan: unknown; outDir?: string; open?: boolean }

export type RenderToolOptions = {
  /** Öffnen-Kommando überschreiben, z. B. "firefox". Standard: Handler des Systems. */
  openWith?: string
  /** Verzeichnis der Sitzung pro Aufruf; relative Pfade (outDir, svgPath) gelten ab dort. */
  directory: DirectoryResolver
}

/**
 * Baut das Tool `plan_render`. Als Fabrik, damit das Plugin seine Optionen
 * (etwa ein abweichendes Öffnen-Kommando) und die Auflösung des Sitzungsverzeichnisses hineingeben kann.
 */
export function createPlanRenderTool(options: RenderToolOptions): Info {
  return {
    name: "plan_render",
    description:
      "Rendert einen Plan aus JSON zu einer eigenständigen HTML-Datei und öffnet sie im Standard-Browser. " +
      "Einziger Weg, einen Plan auszugeben: nie HTML oder Markdown selbst schreiben. " +
      "Nicht schemakonform → nichts geschrieben, Feldfehler kommen zurück, korrigieren und erneut aufrufen. " +
      "Felder und Schreibregeln: Skill \"planify\".",
    // Ohne required: auch ein fehlender Plan geht an ajv und kommt als deutscher Feldfehler zurück.
    input: {
      type: "object",
      properties: {
        plan: planShape,
        outDir: { type: "string", description: "Zielverzeichnis, Standard docs/plans im Projekt" },
        open: { type: "boolean", description: "HTML im Standard-Browser öffnen, Standard true" },
      },
    },
    async execute(input, context) {
      const args = input as RenderInput
      const directory = await options.directory(context)
      const plan = args.plan as any
      const errors = validate(plan)
      if (errors.length) {
        return {
          content: [
            "Plan nicht geschrieben — Schema verletzt:",
            ...errors.map((f) => `  ${f.path || "/"}: ${f.message}`),
            "",
            "Felder korrigieren und plan_render erneut aufrufen.",
          ].join("\n"),
        }
      }

      const targetDir = resolve(directory, args.outDir ?? "docs/plans")
      mkdirSync(targetDir, { recursive: true })
      const name = baseName(plan)
      const jsonPath = resolve(targetDir, `${name}.plan.json`)
      const htmlPath = resolve(targetDir, `${name}.html`)

      let result
      try {
        result = render(plan, { baseDir: directory })
      } catch (renderError) {
        return { content: `Plan nicht geschrieben — Rendern fehlgeschlagen: ${(renderError as Error).message}` }
      }

      writeFileSync(jsonPath, JSON.stringify(plan, null, 2) + "\n", "utf8")
      writeFileSync(htmlPath, result.html, "utf8")

      const openCommand = args.open === false ? undefined : buildOpenCommand(htmlPath, options)
      if (openCommand) {
        spawn(openCommand.command, openCommand.args, { stdio: "ignore", detached: true }).unref()
      }

      const lines = [`Plan geschrieben:`, `  ${jsonPath}`, `  ${htmlPath}`]
      if (openCommand) lines.push(`Im Standard-Browser geöffnet (${openCommand.command}).`)
      else if (args.open !== false) lines.push("Kein Öffnen-Kommando für diese Plattform, Datei bitte selbst öffnen.")
      if (result.warnings.length) {
        lines.push("", "Warnungen zur Schreibweise (bitte im nächsten Zug korrigieren und neu rendern):")
        for (const w of result.warnings) lines.push(`  ${w.path}: ${w.message}`)
      }
      return {
        content: lines.join("\n"),
        metadata: { title: `${plan.ticket} — ${plan.title}`, jsonPath, htmlPath },
      }
    },
  }
}

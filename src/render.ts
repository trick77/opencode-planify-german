import { readFileSync, existsSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv from "ajv"
import addFormats from "ajv-formats"
import nunjucks from "nunjucks"

const here = dirname(fileURLToPath(import.meta.url))
export const root = resolve(here, "..")
export const schemaPath = resolve(root, "skills/planify/schema/plan.schema.json")
export const templateDir = resolve(root, "templates")

export type PlanError = { path: string; message: string }
export type PlanWarning = { path: string; message: string }

// Prosafelder: hier gilt die Schweizer Orthografie. Datenfelder (Pfade, Kommandos)
// bleiben unangetastet, dort darf ein Eszett aus einem Fixture stehen.
const NON_PROSE_KEYS = new Set(["path", "slug", "ticket", "createdAt", "svgPath"])

// Haeufige ASCII-Umschreibungen von Umlauten. Eine reine ue/oe/ae-Suche waere
// nutzlos, weil deutsche Woerter diese Folgen legitim enthalten (manuelle, neue).
const ASCII_TRANSCRIPTION = new RegExp(
  "\\b\\w*(?:" +
    [
      "fuer", "ueber", "uebrig", "uebernahm", "uebernehm", "uebersicht",
      "muess", "muesst", "koenn", "koennt", "moegl", "moecht",
      "aender", "aenderung", "groess", "hoeh", "laeng", "laess", "spaet",
      "naechst", "zurueck", "waehrend", "waehl", "gemaess", "haeuf", "haett",
      "duerf", "wuerd", "schliess", "ausfuehr", "durchfuehr", "einfueg",
      "pruef", "loesch", "loesung", "erklaer", "verfueg", "beruehr", "erhoeh",
      "kuenftig", "urspruengl", "vollstaendig", "abhaengig", "zusaetzl",
    ].join("|") +
    ")\\w*\\b",
  "gi",
)

let validator: ((data: unknown) => boolean) & { errors?: any[] } | undefined

function getValidator() {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true })
    addFormats(ajv)
    validator = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")))
  }
  return validator
}

/** Prüft den Plan gegen das Schema. Leeres Array bedeutet: valide. */
export function validate(plan: unknown): PlanError[] {
  const check = getValidator()
  if (check(plan)) return []
  return (check.errors ?? []).map((f) => ({
    path: f.instancePath || "/",
    message: `${f.message ?? "ungültig"}${f.params && Object.keys(f.params).length ? " (" + JSON.stringify(f.params) + ")" : ""}`,
  }))
}

/** Sucht Eszett und ASCII-Umschreibungen von Umlauten in Prosafeldern. */
export function checkSpelling(plan: unknown): PlanWarning[] {
  const warnings: PlanWarning[] = []
  const walk = (value: unknown, path: string, key?: string) => {
    if (typeof value === "string") {
      if (key && NON_PROSE_KEYS.has(key)) return
      if (value.includes("ß")) {
        warnings.push({ path, message: "Eszett gefunden, Schweizer Orthografie verlangt \"ss\"" })
      }
      const ascii = value.match(ASCII_TRANSCRIPTION)
      if (ascii) {
        warnings.push({
          path,
          message: `mögliche ASCII-Umschreibung eines Umlauts: ${[...new Set(ascii)].join(", ")} — echte Umlaute schreiben`,
        })
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) => walk(entry, `${path}/${i}`, key))
      return
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${path}/${k}`, k)
    }
  }
  walk(plan, "")
  return warnings
}

/** Liest das SVG und entfernt aktive Inhalte, damit die HTML-Datei offline und passiv bleibt. */
export function loadSvg(svgPath: string, baseDir: string): { svg: string; warnings: PlanWarning[] } {
  const absolutePath = isAbsolute(svgPath) ? svgPath : resolve(baseDir, svgPath)
  if (!existsSync(absolutePath)) {
    throw new Error(`SVG nicht gefunden: ${absolutePath}`)
  }
  let svg = readFileSync(absolutePath, "utf8")
  const warnings: PlanWarning[] = []
  const withoutXml = svg.replace(/<\?xml[^>]*\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "")
  svg = withoutXml.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
  if (svg !== withoutXml) {
    warnings.push({ path: "/diagram/svgPath", message: "aktive Inhalte (script/on*) aus dem SVG entfernt" })
  }
  // diagram-design injiziert einen Google-Fonts-Import in exportierte SVG. Der Plan
  // muss offline-fest sein, also fliegt der Import raus; es greifen die Schriften des Themes.
  const withoutImport = svg.replace(/@import\s+url\([^)]*https?:[^)]*\)\s*;?/gi, "")
  if (withoutImport !== svg) {
    svg = withoutImport
    warnings.push({ path: "/diagram/svgPath", message: "entfernter Web-Font-Import aus dem SVG entfernt, damit die Datei offline-fest bleibt" })
  }
  if (/(?:href|src)\s*=\s*["']?https?:/i.test(svg) || /url\(["']?https?:/i.test(svg)) {
    warnings.push({ path: "/diagram/svgPath", message: "SVG verweist auf eine entfernte Ressource, die Datei ist dann nicht offline-fest" })
  }
  const start = svg.indexOf("<svg")
  if (start < 0) throw new Error(`Kein <svg>-Element in ${absolutePath}`)
  return { svg: svg.slice(start).trim(), warnings }
}

export function baseName(plan: any): string {
  return `${plan.ticket}-${plan.slug}`
}

export type RenderResult = { html: string; warnings: PlanWarning[] }

/**
 * Rendert den Plan zu eigenständigem HTML.
 * `baseDir` ist das Verzeichnis, gegen das ein relativer SVG-Pfad aufgelöst wird.
 */
export function render(plan: any, options: { baseDir?: string; template?: string } = {}): RenderResult {
  const errors = validate(plan)
  if (errors.length) {
    throw new Error("Plan ist nicht schemakonform:\n" + errors.map((f) => `  ${f.path}: ${f.message}`).join("\n"))
  }
  const warnings = checkSpelling(plan)
  const baseDir = options.baseDir ?? process.cwd()
  const template = options.template ?? "plan.njk"

  let svg: string | undefined
  if (plan.diagram?.svgPath) {
    const loaded = loadSvg(plan.diagram.svgPath, baseDir)
    svg = loaded.svg
    warnings.push(...loaded.warnings)
  }

  const env = nunjucks.configure(templateDir, { autoescape: true, trimBlocks: true, lstripBlocks: true })
  env.addFilter("date", formatDate)

  const css = readFileSync(resolve(templateDir, "theme.css"), "utf8")
  const html = env.render(template, { plan, css, svg, baseName: baseName(plan) })
  return { html, warnings }
}

function formatDate(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return new Intl.DateTimeFormat("de-CH", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Zurich" }).format(d)
}

// Bitbucket entfernt HTML. Ein "<" in der Prosa würde als Tag-Anfang gelesen und
// samt Text verschluckt, deshalb als Entity.
function escapeText(value: unknown): string {
  return String(value ?? "").replace(/</g, "&lt;")
}

// Tabellenzellen: "|" beendet die Zelle, ein Zeilenumbruch die Tabelle.
function escapeCell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s*\r?\n\s*/g, " ")
}

// Code-Span mit mehr Backticks als im Inhalt, damit ein Backtick im Pfad oder
// Kommando den Span nicht vorzeitig schliesst.
function codeSpan(value: unknown): string {
  const text = String(value ?? "").replace(/\s*\r?\n\s*/g, " ")
  const fence = "`".repeat(longestBacktickRun(text) + 1)
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : ""
  return `${fence}${pad}${text}${pad}${fence}`
}

function codeBlock(lines: string[]): string {
  const text = lines.join("\n")
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1))
  return `${fence}sh\n${text}\n${fence}`
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
}

export type MarkdownResult = { markdown: string; warnings: PlanWarning[] }

/**
 * Rendert den Plan als Markdown für die Description eines Bitbucket-Data-Center-PRs.
 * Ein Diagramm fehlt dort: Bitbucket stellt kein SVG dar, die Description verweist
 * auf den HTML-Plan.
 */
export function renderMarkdown(plan: any): MarkdownResult {
  const errors = validate(plan)
  if (errors.length) {
    throw new Error("Plan ist nicht schemakonform:\n" + errors.map((f) => `  ${f.path}: ${f.message}`).join("\n"))
  }
  const warnings = checkSpelling(plan)
  if (plan.diagram) {
    warnings.push({ path: "/diagram", message: "Diagramm nicht in der PR-Description, Bitbucket stellt kein SVG dar" })
  }

  // Eigene Umgebung statt nunjucks.configure: die setzt die globale Standard-Umgebung,
  // und Markdown braucht autoescape aus, HTML an.
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(templateDir), {
    autoescape: false,
    trimBlocks: true,
    lstripBlocks: true,
  })
  env.addFilter("date", formatDate)
  env.addFilter("text", escapeText)
  env.addFilter("cell", escapeCell)
  env.addFilter("code", codeSpan)
  env.addFilter("codeblock", codeBlock)

  const markdown = env.render("plan.md.njk", { plan, baseName: baseName(plan) })
  return { markdown: markdown.replace(/\n{3,}/g, "\n\n").trim() + "\n", warnings }
}

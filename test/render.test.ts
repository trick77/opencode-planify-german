import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { baseName, loadSvg, checkSpelling, render, renderSummary, validate, root, wrapProse, WRAP_WIDTH, LIST_WRAP_WIDTH } from "../src/render.ts"
import { buildOpenCommand } from "../src/open.ts"

const examplePath = resolve(root, "skills/planify/references/beispiel-plan.json")
const example = () => JSON.parse(readFileSync(examplePath, "utf8"))

test("valider Plan rendert eigenständiges HTML", () => {
  // Given
  const plan = example()

  // When
  const { html, warnings } = render(plan, { baseDir: root })

  // Then
  assert.equal(warnings.length, 0)
  assert.ok(html.startsWith("<!doctype html>"))
  assert.match(html, /<meta charset="utf-8">/)
  assert.match(html, /<html lang="de">/)
  assert.match(html, new RegExp(plan.title))
  assert.match(html, /MapStruct als annotationProcessor/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.doesNotMatch(html, /<img/)
})

test("Umlaute bleiben echte Zeichen und Eszett kommt nicht vor", () => {
  // When
  const { html } = render(example(), { baseDir: root })

  // Then
  assert.ok(html.includes("Änderung") || html.includes("löschen"))
  assert.doesNotMatch(html, /ß/)
  assert.doesNotMatch(html, /&auml;|&uuml;|&ouml;/)
})

test("Dark Mode haengt an der Systemeinstellung, der Ausdruck bleibt hell", () => {
  // When
  const { html } = render(example(), { baseDir: root })

  // Then
  assert.match(html, /@media \(prefers-color-scheme: dark\)/)
  assert.doesNotMatch(html, /data-theme|prefers-color-scheme: light/)
  // kein Schalter im Dokument: die Datei bleibt passiv
  assert.doesNotMatch(html, /<script|<input/)
  // die Dark-Media-Query steht vor dem Druckblock, sonst gewinnt sie beim Ausdruck
  assert.ok(html.indexOf("prefers-color-scheme: dark") < html.indexOf("@media print"))
  // der Plan selbst sagt, woher die Darstellung kommt
  assert.match(html, /hell\/dunkel: Systemeinstellung/)
})

test("unvollständiger Plan liefert Feldfehler statt HTML", () => {
  // Given
  const plan = example()
  delete plan.verification

  // When
  const errors = validate(plan)

  // Then
  assert.ok(errors.length > 0)
  assert.ok(errors.some((f) => f.message.includes("verification")))
  assert.throws(() => render(plan, { baseDir: root }), /nicht schemakonform/)
})

test("Ticket ohne Muster wird abgelehnt", () => {
  // Given
  const plan = example()
  plan.ticket = "kein-ticket"

  // When
  const errors = validate(plan)

  // Then
  assert.ok(errors.some((f) => f.path === "/ticket"))
})

test("Eszett und ASCII-Umschreibung werden als Warnung gemeldet", () => {
  // Given
  const plan = example()
  plan.intent = "Die Groesse der Aenderung heißt, dass wir fuer den Build eine neue, manuelle Lösung brauchen."

  // When
  const warnings = checkSpelling(plan)

  // Then
  assert.ok(warnings.some((w) => w.message.includes("Eszett")))
  const ascii = warnings.find((w) => w.message.includes("ASCII-Umschreibung"))
  assert.ok(ascii)
  assert.match(ascii.message, /Groesse/)
  assert.match(ascii.message, /fuer/)
  assert.doesNotMatch(ascii.message, /manuelle|neue/)
})

test("Pfade und Kommandos werden nicht auf Orthografie geprüft", () => {
  // Given
  const plan = example()
  plan.steps[0].files[0].path = "src/Strassenverzeichnis-groß.java"

  // When
  const warnings = checkSpelling(plan)

  // Then
  assert.equal(warnings.length, 0)
})

test("SVG wird inline eingebettet, aktive Inhalte fliegen raus", () => {
  // Given
  const dir = mkdtempSync(resolve(tmpdir(), "planify-"))
  const svgPath = resolve(dir, "abhaengigkeiten.svg")
  writeFileSync(
    svgPath,
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect onclick="alert(2)" width="10" height="10"/></svg>',
    "utf8",
  )
  const plan = example()
  plan.diagram = { title: "Abhängigkeiten", caption: "Beispiel", svgPath: "abhaengigkeiten.svg" }

  // When
  const { html, warnings } = render(plan, { baseDir: dir })
  const loaded = loadSvg(svgPath, dir)

  // Then
  assert.match(html, /<svg /)
  assert.doesNotMatch(html, /<script>alert/)
  assert.doesNotMatch(html, /onclick/)
  assert.match(html, /Abhängigkeiten/)
  assert.ok(loaded.svg.startsWith("<svg"))
  assert.ok(warnings.some((w) => w.message.includes("aktive Inhalte")))
})

test("fehlendes SVG bricht mit klarer Meldung ab", () => {
  // Given
  const plan = example()
  plan.diagram = { title: "Fehlt", svgPath: "gibt-es-nicht.svg" }

  // When / Then
  assert.throws(() => render(plan, { baseDir: root }), /SVG nicht gefunden/)
})

test("Dateiname setzt sich aus Ticket und Slug zusammen", () => {
  // When / Then
  assert.equal(baseName(example()), "SEP-24758-mapstruct-gradle-migration")
})

test("Nunjucks escapt Inhalte aus dem Plan", () => {
  // Given
  const plan = example()
  plan.steps[0].title = "<script>alert('x')</script>"

  // When
  const { html } = render(plan, { baseDir: root })

  // Then
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;/)
})

test("Web-Font-Import aus einem diagram-design-Export wird entfernt", () => {
  // Given
  const dir = mkdtempSync(resolve(tmpdir(), "planify-"))
  const svgPath = resolve(dir, "architektur.svg")
  writeFileSync(
    svgPath,
    '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      "<defs><style>@import url('https://fonts.googleapis.com/css2?family=Geist&amp;display=swap');</style></defs>" +
      '<rect width="10" height="10"/></svg>',
    "utf8",
  )
  const plan = example()
  plan.diagram = { title: "Architektur", svgPath: "architektur.svg" }

  // When
  const { html, warnings } = render(plan, { baseDir: dir })

  // Then
  assert.doesNotMatch(html, /fonts\.googleapis\.com/)
  // xmlns bleibt erlaubt, es ist eine Namensraum-URI und kein Abruf
  assert.doesNotMatch(html, /(?:href|src)\s*=\s*["']https?:/)
  assert.doesNotMatch(html, /url\(["']?https?:/)
  assert.ok(warnings.some((w) => w.message.includes("Web-Font-Import")))
})

test("Plugin registriert die Tools plan_render und pr_summary", async () => {
  // Given
  const { default: plugin } = await import("../src/index.ts")
  const added: { name: string; description: string; input: { type: string } }[] = []
  const ctx = {
    location: { directory: "/projekt" },
    options: { openWith: "firefox" },
    tool: { transform: async (callback: (editor: unknown) => void) => callback({ add: (t: never) => added.push(t) }) },
  }

  // When
  await plugin.setup(ctx as never)

  // Then
  assert.equal(plugin.id, "opencode-planify-german")
  assert.deepEqual(added.map((t) => t.name), ["plan_render", "pr_summary"])
  assert.match(added[0].description, /Plan/)
  assert.match(added[1].description, /Description/)
  assert.ok(added.every((t) => t.input.type === "object"))
})

test("plan_render schreibt JSON und HTML ins Projektverzeichnis", async () => {
  // Given
  const { createPlanRenderTool } = await import("../src/tool.ts")
  const directory = mkdtempSync(resolve(tmpdir(), "planify-tool-"))
  const tool = createPlanRenderTool({ directory })

  // When
  const result = await tool.execute({ plan: example(), open: false }, {} as never)

  // Then
  const name = baseName(example())
  assert.match(result.content as string, /^Plan geschrieben:/)
  assert.ok(existsSync(resolve(directory, "docs/plans", `${name}.plan.json`)))
  assert.ok(existsSync(resolve(directory, "docs/plans", `${name}.html`)))
  assert.equal(result.metadata?.htmlPath, resolve(directory, "docs/plans", `${name}.html`))
})

test("plan_render meldet Schemaverletzungen, ohne zu schreiben", async () => {
  // Given
  const { createPlanRenderTool } = await import("../src/tool.ts")
  const directory = mkdtempSync(resolve(tmpdir(), "planify-tool-"))
  const tool = createPlanRenderTool({ directory })

  // When
  const result = await tool.execute({ plan: { ...example(), verification: [] }, open: false }, {} as never)

  // Then
  assert.match(result.content as string, /^Plan nicht geschrieben — Schema verletzt:/)
  assert.ok(!existsSync(resolve(directory, "docs/plans")))
})

test("Schema und Templates liegen unter der Paketwurzel", () => {
  // Given / When / Then
  assert.ok(existsSync(resolve(root, "skills/planify/schema/plan.schema.json")))
  assert.ok(existsSync(resolve(root, "templates/plan.njk")))
  assert.ok(existsSync(resolve(root, "templates/theme.css")))
})

test("Öffnen-Kommando folgt der Plattform", () => {
  // Given
  const env = {}

  // When / Then
  assert.deepEqual(buildOpenCommand("/x/plan.html", { platform: "darwin", env }), {
    command: "open",
    args: ["/x/plan.html"],
  })
  assert.deepEqual(buildOpenCommand("/x/plan.html", { platform: "linux", env }), {
    command: "xdg-open",
    args: ["/x/plan.html"],
  })
  assert.deepEqual(buildOpenCommand("/x/plan.html", { platform: "win32", env }), {
    command: "cmd",
    args: ["/c", "start", "", "/x/plan.html"],
  })
  assert.equal(buildOpenCommand("/x/plan.html", { platform: "sunos", env }), undefined)
})

test("openWith und PLANIFY_OPEN schlagen den Plattform-Standard", () => {
  // Given
  const env = { PLANIFY_OPEN: "chromium" }

  // When / Then
  assert.deepEqual(buildOpenCommand("/x/plan.html", { platform: "darwin", env }), {
    command: "chromium",
    args: ["/x/plan.html"],
  })
  assert.deepEqual(
    buildOpenCommand("/x/plan.html", { openWith: "flatpak run org.mozilla.firefox", platform: "linux", env }),
    { command: "flatpak", args: ["run", "org.mozilla.firefox", "/x/plan.html"] },
  )
})

test("Zusammenfassung escapt nur dokumentierte Zeichen, ein Absatz wird eine Zeile vor dem Umbruch", () => {
  // Given
  const summary = [
    "Feld snake_case\nund *Stern* umbenennen",
    "# keine Überschrift, `my_var` bleibt Code, a < b & c",
    "1) keine Liste, und ```js kein Codeblock",
  ].join("\n\n")

  // When
  const { markdown, warnings } = renderSummary(summary)

  // Then
  assert.equal(warnings.length, 0)
  assert.equal(
    markdown,
    "Feld snake\\_case und \\*Stern\\* umbenennen\n\n" +
      "\\# keine Überschrift, `my_var` bleibt Code, a < b & c\n\n" +
      "1\\) keine Liste, und ```js kein Codeblock\n",
  )
})

test("Zusammenfassung braucht 3-4 Absätze und bricht bei 110 Zeichen um", () => {
  // Given
  const paragraph = Array.from({ length: 40 }, (_, i) => `wort${i}`).join(" ")
  const paragraphs = (n: number) => Array.from({ length: n }, () => paragraph).join("\n\n  \n")

  // When
  const { markdown } = renderSummary(paragraphs(4))

  // Then
  assert.throws(() => renderSummary(paragraphs(2)), /2 Absätze, erlaubt 3-4/)
  assert.throws(() => renderSummary(paragraphs(5)), /5 Absätze, erlaubt 3-4/)
  assert.doesNotThrow(() => renderSummary(paragraphs(3)))
  assert.equal(markdown.trimEnd().split("\n\n").length, 4)
  assert.ok(markdown.split("\n").every((line) => line.length <= WRAP_WIDTH))
  assert.ok(markdown.split("\n").length > 8)
})

test("Prosa bricht bei 110 Zeichen um, Listenpunkte bei 90 mit hängendem Einzug", () => {
  // Given
  const words = Array.from({ length: 60 }, (_, i) => `wort${i}`).join(" ")
  const markdown = wrapProse(`${words}\n\n- ${words}\n\n## ${words}\n\n\`\`\`sh\n${words}\n\`\`\``)

  // When
  const lines = markdown.split("\n")
  const [prose, list, heading, fenced] = markdown.split("\n\n")

  // Then
  assert.ok(prose.split("\n").length > 1)
  assert.ok(prose.split("\n").every((line) => line.length <= WRAP_WIDTH))
  assert.ok(list.split("\n").every((line) => line.length <= LIST_WRAP_WIDTH))
  assert.ok(list.split("\n").slice(1).every((line) => line.startsWith("  wort")))
  assert.equal(heading, `## ${words}`)
  assert.equal(fenced, `\`\`\`sh\n${words}\n\`\`\``)
  assert.ok(lines.length > 4)
})

test("Umbruch trennt keinen Code-Span und beginnt keine Zeile mit einem Blockmarker", () => {
  // Given
  const filler = "x".repeat(100)
  const text = `${filler} \`ein langer code span\` und - danach 1. weiter`

  // When
  const lines = wrapProse(text, 110, 90).split("\n")

  // Then
  assert.ok(lines.some((line) => line.includes("`ein langer code span`")))
  assert.ok(lines.every((line) => !/^(?:[-+*>#]|\d+[.)])(\s|$)/.test(line)))
})

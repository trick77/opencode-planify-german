import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { baseName, loadSvg, checkSpelling, render, renderMarkdown, validate, root } from "../src/render.ts"
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

test("Plugin registriert die Tools plan_render und plan_pr", async () => {
  // Given
  const { PlanifyPlugin } = await import("../src/plugin.ts")

  // When
  const hooks = await PlanifyPlugin({} as never)

  // Then
  assert.ok(hooks.tool)
  assert.deepEqual(Object.keys(hooks.tool), ["plan_render", "plan_pr"])
  assert.match(hooks.tool.plan_render.description, /Plan/)
  assert.match(hooks.tool.plan_pr.description, /Description/)
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

test("Markdown für die PR-Description hat alle Abschnitte in fester Reihenfolge", () => {
  // When
  const { markdown, warnings } = renderMarkdown(example())

  // Then
  assert.equal(warnings.length, 0)
  const headings = markdown.split("\n").filter((line) => line.startsWith("## "))
  assert.deepEqual(headings, [
    "## Kontext",
    "## Schritte",
    "## Verifikation",
    "## Risiken",
    "## Offene Entscheidungen",
    "## Nicht enthalten",
  ])
  assert.match(markdown, /^# MapStruct-Mapper/)
  assert.match(markdown, /- `build\.gradle\.kts` — MapStruct/)
  assert.match(markdown, /`SEP-24758-mapstruct-gradle-migration\.plan\.json`/)
  assert.ok(markdown.includes("Änderungen") && !markdown.includes("ß"))
  assert.doesNotMatch(markdown, /undefined|\n{3,}/)
})

test("Markdown escapt Tabellenzellen, Code-Spans und spitze Klammern", () => {
  // Given
  const plan = example()
  plan.verification[0] = { how: "grep 'a|b' `x`", expected: "Zeile eins\nZeile <zwei>" }
  plan.steps[0].files[0].path = "src/`odd`.ts"

  // When
  const { markdown } = renderMarkdown(plan)

  // Then
  // Polster-Leerzeichen nur, wenn der Inhalt mit einem Backtick beginnt oder endet
  assert.ok(markdown.includes("| `` grep 'a\\|b' `x` `` | Zeile eins Zeile &lt;zwei> |"))
  assert.ok(markdown.includes("- ``src/`odd`.ts`` —"))
})

test("Diagramm fehlt im Markdown, mit Warnung und Hinweis", () => {
  // Given
  const plan = example()
  plan.diagram = { title: "Ablauf", svgPath: "gibt-es-nicht.svg" }

  // When
  const { markdown, warnings } = renderMarkdown(plan)

  // Then
  assert.match(markdown, /## Ablauf\n\n_Das Diagramm steht nur im HTML-Plan/)
  assert.doesNotMatch(markdown, /<svg/)
  assert.ok(warnings.some((w) => w.path === "/diagram"))
})

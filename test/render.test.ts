import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { baseName, loadSvg, checkSpelling, render, renderMarkdown, validate, root, wrapProse, WRAP_WIDTH, LIST_WRAP_WIDTH } from "../src/render.ts"
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

test("Markdown escapt nur dokumentierte Zeichen und hält Prosa auf einer Zeile", () => {
  // Given
  const plan = example()
  plan.steps[0].title = "Feld snake_case\nund *Stern* umbenennen"
  plan.steps[0].rationale = "# keine Überschrift, `my_var` bleibt Code, a < b & c"
  plan.verification[0] = { how: "grep 'a|b' `x`", expected: "1. keine Liste" }
  plan.steps[0].files[0].path = "src/`odd`.ts"

  // When
  const { markdown } = renderMarkdown(plan)

  // Then
  assert.ok(markdown.includes("### 1. Feld snake\\_case und \\*Stern\\* umbenennen\n"))
  assert.ok(markdown.includes("\\# keine Überschrift, `my_var` bleibt Code, a < b & c"))
  assert.ok(markdown.includes("- `` grep 'a|b' `x` `` — 1\\. keine Liste"))
  assert.ok(markdown.includes("- ``src/`odd`.ts`` —"))
  assert.doesNotMatch(markdown, /&lt;|&amp;|\n\|/)
})

test("Prosa, die mit 1) oder einem Codezaun beginnt, wird keine Liste und kein Codeblock", () => {
  // Given
  const plan = example()
  plan.intent = "1) Erst das Schema anpassen, danach die Mapper neu generieren lassen."
  plan.steps[0].rationale = "```js wäre hier falsch"

  // When
  const { markdown } = renderMarkdown(plan)

  // Then
  assert.ok(markdown.includes("\n1\\) Erst das Schema anpassen, danach die Mapper neu generieren lassen.\n"))
  assert.ok(markdown.includes("\n\\`\\`\\`js wäre hier falsch\n"))
  assert.equal(markdown.split("\n").filter((line) => line.startsWith("```")).length, 2)
})

test("Kommandos mit Leerzeilen bleiben im Codeblock unverändert, ``` im Kommando wird eingerückt", () => {
  // Given
  const plan = example()
  plan.steps[0].commands = ["cat <<EOF", "", "", "EOF"]
  plan.steps[1].commands = ["echo '```' && rm *.tmp", "", "", "echo fertig"]

  // When
  const { markdown } = renderMarkdown(plan)

  // Then
  assert.ok(markdown.includes("```sh\ncat <<EOF\n\n\nEOF\n```"))
  // "Kommandos:" beendet die Dateiliste, sonst wäre der Block Teil des letzten Punkts
  assert.ok(markdown.includes("\n\nKommandos:\n\n    echo '```' && rm *.tmp\n    \n    \n    echo fertig\n"))
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

test("Diagramm fehlt im Markdown, mit Warnung und Hinweis", () => {
  // Given
  const plan = example()
  plan.diagram = { title: "Ablauf", svgPath: "gibt-es-nicht.svg" }

  // When
  const { markdown, warnings } = renderMarkdown(plan)

  // Then
  assert.match(markdown, /## Ablauf\n\nDas Diagramm steht nur im HTML-Plan/)
  assert.doesNotMatch(markdown, /<svg/)
  assert.ok(warnings.some((w) => w.path === "/diagram"))
})

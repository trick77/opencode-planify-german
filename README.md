# planify

Pläne für OpenCode: das Modell liefert JSON, planify rendert daraus eine
eigenständige HTML-Datei (Nunjucks) und öffnet sie im Standard-Browser des
Systems. Kein MCP-Server. Nur OpenCode.

## Bestandteile

| Teil | Datei | Wirkung |
| --- | --- | --- |
| Instructions | `instructions/planify.md` | Immer geladen: Deutsch, echte Umlaute, kein Eszett, Plan nur als JSON über `plan_render`. |
| Skill | `skills/planify/SKILL.md` | Auf Abruf: Schema, Feldbedeutungen, Schreibregeln, Diagrammweg, Beispiel. |
| Plugin | `src/plugin.ts` | Registriert das Tool `plan_render`: validiert, schreibt JSON und HTML nach `docs/plans/`, öffnet die Datei. |
| Renderer | `src/render.ts`, `templates/` | Schema-Prüfung (ajv), Orthografie-Warnungen, Nunjucks, SVG inline. |

## Installation

In `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["planify@git+https://github.com/trick77/planify.git#v0.1.0"],
  "instructions": ["/pfad/zu/planify/instructions/planify.md"],
  "skills": { "paths": ["/pfad/zu/planify/skills"] }
}
```

Das Plugin bringt das Tool mit, `instructions` macht die Regeln verbindlich,
`skills.paths` liefert die Detaildokumentation. Instructions und Skill brauchen
einen Pfad auf der Platte — entweder aus einem Clone dieses Repos oder aus dem
Preset `planify` von
[opencode-presets](https://github.com/trick77/opencode-presets), das die Dateien
gepinnt in den Cache holt.

Prüfen:

```
opencode debug agent plan | grep plan_render
opencode debug skill | grep planify
```

### Alternative ohne Plugin

Statt des `plugin`-Eintrags lässt sich das Tool auch als Datei registrieren:

```
ln -sfn "$PWD/tools/plan.ts" ~/.config/opencode/tool/plan.ts
```

Der Tool-Name entsteht aus Dateiname plus Export: `plan.ts` mit
`export const render` ergibt `plan_render`.

## Browser

Geöffnet wird mit dem Standard-Handler des Systems: `open` auf macOS,
`xdg-open` auf Linux, `start` auf Windows. Überschreiben geht über die
Plugin-Option `openWith` oder die Umgebungsvariable `PLANIFY_OPEN`:

```json
{ "plugin": [["planify@git+https://github.com/trick77/planify.git#v0.1.0", { "openWith": "firefox" }]] }
```

`plan_render` mit `open: false` schreibt die Dateien, ohne etwas zu öffnen.

## Diagramme

Optional und nur, wenn ein Diagramm Struktur zeigt, die die Prosa nicht trägt.
Erzeugt wird es mit der Skill `diagram-design`, als SVG exportiert, der Pfad
steht in `diagram.svgPath`. planify bettet das SVG inline ein und entfernt dabei
`script`, `on*`-Attribute und den Google-Fonts-Import, damit die Plan-Datei
offline-fest bleibt.

Installation der Skill für OpenCode:

```
git clone https://github.com/cathrynlavery/diagram-design.git
ln -sfn "$PWD/diagram-design/skills/diagram-design" ~/.config/opencode/skills/diagram-design
```

## Entwicklung

```
npm test
npm run render -- skills/planify/references/beispiel-plan.json --out /tmp/planify-test
```

Läuft mit Node (Type-Stripping), Bun wird nicht gebraucht. Der Renderer warnt
bei Eszett und bei ASCII-Umschreibungen von Umlauten in Prosafeldern; Pfade,
Kommandos und der Slug sind davon ausgenommen.

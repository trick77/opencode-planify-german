# planify

Pläne für OpenCode: das Modell liefert JSON, planify rendert daraus eine
eigenständige HTML-Datei (Nunjucks, Anthropic-nahe Anmutung) und öffnet sie in
Safari. Kein MCP-Server. Nur OpenCode.

## Bestandteile

| Teil | Datei | Wirkung |
| --- | --- | --- |
| Instructions | `instructions/planify.md` | Immer geladen: Deutsch, echte Umlaute, kein Eszett, Plan nur als JSON über `plan_render`. |
| Skill | `skills/planify/SKILL.md` | Auf Abruf: Schema, Feldbedeutungen, Schreibregeln, Diagrammweg, Beispiel. |
| Tool | `tools/plan.ts` | Tool `plan_render`: validiert, schreibt JSON und HTML nach `docs/plans/`, öffnet Safari. |
| Renderer | `src/render.ts`, `templates/` | Schema-Prüfung (ajv), Orthografie-Warnungen, Nunjucks, SVG inline. |

## Installation

```
npm install
ln -sfn "$PWD/tools/plan.ts"      ~/.config/opencode/tool/plan.ts
ln -sfn "$PWD/skills/planify"     ~/.config/opencode/skills/planify
```

Dazu in `~/.config/opencode/opencode.json` den absoluten Pfad dieses Repos
eintragen:

```json
"instructions": ["/pfad/zu/planify/instructions/planify.md"]
```

Der Tool-Name kommt aus Dateiname plus Export: `tool/plan.ts` mit
`export const render` ergibt `plan_render`. OpenCode lädt sowohl `tool/` als
auch `tools/`; hier wird `tool/` benutzt, passend zu `agent/` und `command/`.

Prüfen:

```
opencode debug skill | grep planify
opencode debug agent plan | grep plan_render
```

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

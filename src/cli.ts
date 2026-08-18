import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { readFileSync } from "node:fs"
import { rendere, dateiname } from "./render.ts"

const argumente = process.argv.slice(2)
const planPfad = argumente.find((a) => !a.startsWith("--"))
if (!planPfad) {
  console.error("Aufruf: npm run render -- <plan.json> [--out <verzeichnis>] [--template plan.njk]")
  process.exit(2)
}
const holeOption = (name: string) => {
  const i = argumente.indexOf(`--${name}`)
  return i >= 0 ? argumente[i + 1] : undefined
}

const absoluterPlan = resolve(process.cwd(), planPfad)
const plan = JSON.parse(readFileSync(absoluterPlan, "utf8"))
const ausgabe = resolve(process.cwd(), holeOption("out") ?? dirname(absoluterPlan))

let ergebnis
try {
  ergebnis = rendere(plan, { basis: dirname(absoluterPlan), template: holeOption("template") })
} catch (fehler) {
  console.error(String((fehler as Error).message))
  process.exit(1)
}

mkdirSync(ausgabe, { recursive: true })
const ziel = resolve(ausgabe, `${dateiname(plan)}.html`)
writeFileSync(ziel, ergebnis.html, "utf8")
for (const w of ergebnis.warnungen) console.warn(`Warnung ${w.pfad}: ${w.meldung}`)
console.log(ziel)

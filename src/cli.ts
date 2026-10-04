import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { baseName, render } from "./render.ts"

const argv = process.argv.slice(2)
const planArg = argv.find((a) => !a.startsWith("--"))
if (!planArg) {
  console.error("Aufruf: npm run render -- <plan.json> [--out <verzeichnis>] [--template plan.njk]")
  process.exit(2)
}
const getOption = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const planPath = resolve(process.cwd(), planArg)
const plan = JSON.parse(readFileSync(planPath, "utf8"))
const outDir = resolve(process.cwd(), getOption("out") ?? dirname(planPath))

let result
try {
  result = render(plan, { baseDir: dirname(planPath), template: getOption("template") })
} catch (error) {
  console.error(String((error as Error).message))
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
const target = resolve(outDir, `${baseName(plan)}.html`)
writeFileSync(target, result.html, "utf8")
for (const w of result.warnings) console.warn(`Warnung ${w.path}: ${w.message}`)
console.log(target)

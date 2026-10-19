import { execFile } from "node:child_process"
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool"
import {
  BitbucketError,
  createPullRequest,
  findOpenPullRequests,
  getDefaultReviewers,
  getRepository,
  normalizeBaseUrl,
  parsePullRequestUrl,
  parseRemote,
  setDescription,
  UncertainOutcomeError,
  type BitbucketConfig,
  type PullRequest,
  type RepoRef,
  type Reviewer,
} from "./bitbucket.ts"
import { renderSummary } from "./render.ts"
import type { DirectoryResolver } from "./tool.ts"

// Grenze für die Description. Wert unverifiziert: auf der eigenen Instanz messen und
// hier nachziehen. Darüber lehnt das Tool ab, statt Bitbucket kürzen zu lassen.
export const MAX_DESCRIPTION_LENGTH = 32_000

const INSTALL_HINT =
  "npx opencode-presets install opencode-planify-german " +
  "--set bitbucketUrl=https://<bitbucket-host> --set-env bitbucketToken=<ENV_VAR_MIT_TOKEN>"

export type PrToolOptions = {
  /** Verzeichnis der Sitzung pro Aufruf; dort laufen die git-Abfragen. */
  directory: DirectoryResolver
  bitbucketUrl?: string
  bitbucketToken?: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  /** Timeout pro Bitbucket-Anfrage, überschreibbar für Tests. */
  timeoutMs?: number
  /** git-Aufruf überschreibbar für Tests. */
  git?: Git
}

type Git = (args: string[], cwd: string) => Promise<string>

// Asynchron: ein synchroner Aufruf blockiert den ganzen opencode-Prozess.
function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", signal }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolvePromise(stdout.trim())
    })
  })
}

type BranchTarget = { local: string; pushBranch?: string; upstreamBranch?: string; remoteName: string }

const MAIN_BRANCHES = new Set(["master", "main"])

function remoteBranch(remoteName: string | undefined, ref: string | undefined): string | undefined {
  const prefix = `refs/remotes/${remoteName}/`
  return remoteName && ref?.startsWith(prefix) ? ref.slice(prefix.length) : undefined
}

/**
 * Lokaler Branch, wohin er gepusht wird und sein Upstream. Die PR-Suche nimmt bewusst
 * nie den Upstream: nach "checkout -b feature origin/master" zeigt der auf master, und
 * die Suche träfe einen fremden PR. Der Upstream dient nur als Vorschlag fürs Ziel.
 * Mit push.default=simple bleibt %(push) leer, bis "push -u" den Upstream auf den
 * Branch selbst setzt: gepusht heisst darum nicht pushBranch gesetzt.
 */
async function branchTarget(git: Git, cwd: string): Promise<BranchTarget | undefined> {
  const local = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
  if (local === "HEAD") return undefined
  const refs = await git(
    ["for-each-ref", "--format=%(push:remotename)%00%(push)%00%(upstream:remotename)%00%(upstream)", `refs/heads/${local}`],
    cwd,
  )
  const [remoteName, pushRef, upstreamRemote, upstreamRef] = refs.split("\0")
  return {
    local,
    pushBranch: remoteBranch(remoteName, pushRef),
    upstreamBranch: remoteBranch(upstreamRemote, upstreamRef),
    remoteName: remoteName || "origin",
  }
}

async function remoteRefExists(git: Git, cwd: string, remoteName: string, branch: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteName}/${branch}`], cwd)
    return true
  } catch {
    return false
  }
}

/**
 * Ziel-Vorschlag: der Branch, von dem abgezweigt wurde, ausser master/main oder dem
 * Branch selbst. Erst der Upstream, dann der Reflog ("branch: Created from
 * origin/release-2.3"), der auch "push -u" übersteht. Nur Branches, die es auf dem
 * Remote gibt.
 */
async function suggestTarget(git: Git, cwd: string, target: BranchTarget, source: string): Promise<string | undefined> {
  const candidates = [target.upstreamBranch]
  const created = await oldestReflogMatch(git, cwd, `refs/heads/${target.local}`, /^branch: Created from (.+)$/)
  if (created && created !== "HEAD") {
    candidates.push(created)
  } else {
    // "checkout -b feat" auf release-2.3 schreibt "Created from HEAD"; die Basis steht
    // dann im Reflog von HEAD.
    const escaped = target.local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    candidates.push(await oldestReflogMatch(git, cwd, "HEAD", new RegExp(`^checkout: moving from (.+) to ${escaped}$`)))
  }
  for (const candidate of candidates) {
    const base = candidate && stripRemote(candidate.replace(/^refs\/(heads|remotes)\//, ""), target.remoteName)
    if (!base || base === "HEAD" || base === source || base === target.local || MAIN_BRANCHES.has(base)) continue
    if (await remoteRefExists(git, cwd, target.remoteName, base)) return base
  }
  return undefined
}

async function oldestReflogMatch(git: Git, cwd: string, ref: string, pattern: RegExp): Promise<string | undefined> {
  try {
    const entries = (await git(["reflog", "show", "--format=%gs", ref], cwd)).split("\n")
    for (let i = entries.length - 1; i >= 0; i--) {
      const match = entries[i].match(pattern)
      if (match) return match[1]
    }
  } catch {
    // Kein Reflog, kein Vorschlag daraus.
  }
  return undefined
}

function stripRemote(name: string, remoteName: string): string {
  const prefix = `${remoteName}/`
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/** Ziel-Branch, wie er auf dem Remote heisst; "origin/x" wird zu "x". Unbekannt → undefined. */
async function resolveTarget(git: Git, cwd: string, remoteName: string, wanted: string): Promise<string | undefined> {
  for (const name of [wanted, stripRemote(wanted, remoteName)]) {
    if (await remoteRefExists(git, cwd, remoteName, name)) return name
  }
  return undefined
}

function describePullRequest(pr: PullRequest): string {
  return `  #${pr.id} → ${pr.targetBranch}: ${pr.title}\n    ${pr.url}`
}

/**
 * Baut das Tool `pr_summary`: schreibt eine Zusammenfassung (Aufgabe, Problem,
 * Lösung) in die Description eines offenen Bitbucket-Data-Center-PRs. Nur auf
 * Anfrage des Benutzers.
 */
export function createPrSummaryTool(options: PrToolOptions): Info {
  return {
    name: "pr_summary",
    description:
      "Schreibt eine Zusammenfassung in die Description eines offenen Bitbucket-Data-Center-Pull-Requests und " +
      "ersetzt sie vollständig: 3-4 Absätze Prosa, getrennt durch eine Leerzeile — Aufgabe, Problem oder " +
      "Herausforderung, Lösung. Keine Überschriften, keine Listen; den Umbruch macht das Tool. Nie als Kommentar. " +
      "Hat der aktuelle Branch keinen offenen PR, legt das Tool mit title und targetBranch einen Draft-PR mit " +
      "dieser Description und den Default-Reviewern an; ohne die beiden liefert es einen Ziel-Vorschlag, den der " +
      "Benutzer bestätigen muss. Nur aufrufen, wenn der Benutzer es verlangt. Ohne prUrl wird der offene PR des " +
      "aktuellen Branches gesucht.",
    input: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "3-4 Absätze Prosa, getrennt durch eine Leerzeile: Aufgabe, Problem oder Herausforderung, Lösung",
        },
        prUrl: {
          type: "string",
          description: "PR-URL aus dem Browser. Nur nötig, wenn der Branch mehrere offene PRs hat oder ein anderer PR gemeint ist",
        },
        title: { type: "string", description: "Titel des neuen PRs. Nur zum Anlegen, wenn der Branch keinen offenen PR hat" },
        targetBranch: {
          type: "string",
          description: "Ziel-Branch des neuen PRs, vom Benutzer bestätigt. Nur zum Anlegen, nie raten",
        },
      },
      required: ["summary"],
    },
    async execute(input, context) {
      const text = await summarize(options, input as SummaryInput, context)
      return typeof text === "string" ? { content: text } : text
    },
  }
}

type SummaryInput = { summary: string; prUrl?: string; title?: string; targetBranch?: string }

// Fehlertexte gehen als String zurück, ein Erfolg samt Metadaten als Result.
async function summarize(options: PrToolOptions, args: SummaryInput, context: ToolContext): Promise<string | Result> {
  const env = options.env ?? process.env
  const signal = context.signal
  const git: Git = options.git ?? ((gitArgs, cwd) => runGit(gitArgs, cwd, signal))
  const token = options.bitbucketToken?.trim() || env.PLANIFY_BITBUCKET_TOKEN?.trim()
  const configuredUrl = options.bitbucketUrl?.trim() || env.PLANIFY_BITBUCKET_URL?.trim()
  const title = args.title?.trim()
  let targetBranch = args.targetBranch?.trim().replace(/^refs\/heads\//, "")

  if (!token) {
    return [
      "PR nicht geändert — kein Bitbucket-Token konfiguriert.",
      "planify mit Token neu installieren und opencode neu starten:",
      `  ${INSTALL_HINT}`,
      "Alternativ Umgebungsvariable PLANIFY_BITBUCKET_TOKEN setzen.",
    ].join("\n")
  }

  let rendered
  try {
    rendered = renderSummary(args.summary)
  } catch (error) {
    return `PR nicht geändert — ${(error as Error).message}`
  }
  if (rendered.markdown.length > MAX_DESCRIPTION_LENGTH) {
    return (
      `PR nicht geändert — Description wäre ${rendered.markdown.length} Zeichen lang, ` +
      `Grenze ${MAX_DESCRIPTION_LENGTH}. Zusammenfassung kürzen.`
    )
  }

  if (!configuredUrl) {
    return [
      "PR nicht geändert — keine Bitbucket-URL konfiguriert.",
      `planify mit URL neu installieren: ${INSTALL_HINT}`,
      "Alternativ Umgebungsvariable PLANIFY_BITBUCKET_URL setzen.",
    ].join("\n")
  }
  let baseUrl: string
  try {
    baseUrl = normalizeBaseUrl(configuredUrl)
  } catch {
    return `PR nicht geändert — Bitbucket-URL ungültig: ${configuredUrl}`
  }

  const config: BitbucketConfig = { baseUrl, token, fetch: options.fetch, timeoutMs: options.timeoutMs, signal }
  let repo: RepoRef
  let id: number
  try {
    if (args.prUrl) {
      if (title || targetBranch) {
        return "PR nicht geändert — prUrl meint einen bestehenden PR, title und targetBranch nur zum Anlegen. Eins von beiden weglassen."
      }
      const ref = parsePullRequestUrl(args.prUrl)
      // Der Token geht nur an die konfigurierte Instanz. Eine PR-URL kommt vom Modell
      // und kann vertippt oder untergeschoben sein.
      if (normalizeBaseUrl(ref.baseUrl) !== baseUrl) {
        return [
          `PR nicht geändert — PR-URL zeigt auf ${ref.baseUrl}, konfiguriert ist ${baseUrl}.`,
          "Der Token wird nur an die konfigurierte Bitbucket-Instanz gesendet.",
        ].join("\n")
      }
      repo = ref
      id = ref.id
    } else {
      const directory = await options.directory(context)
      let target: BranchTarget | undefined
      let remote: string
      try {
        target = await branchTarget(git, directory)
        if (!target) {
          return "PR nicht geändert — kein Branch ausgecheckt (detached HEAD). Branch auschecken oder PR-URL angeben."
        }
        remote = await git(["remote", "get-url", target.remoteName], directory)
      } catch (error) {
        return `PR nicht geändert — git-Abfrage fehlgeschlagen: ${(error as Error).message}`
      }
      repo = parseRemote(remote)
      if (targetBranch) {
        const resolved = await resolveTarget(git, directory, target.remoteName, targetBranch)
        if (!resolved) {
          return `PR nicht geändert — Ziel-Branch ${targetBranch} gibt es auf ${target.remoteName} nicht (git fetch?).`
        }
        targetBranch = resolved
      }
      // Erst der lokale Name, dann das Push-Ziel, falls es anders heisst.
      let branch = target.local
      let open = await findOpenPullRequests(config, repo, branch)
      if (open.length === 0 && target.pushBranch && target.pushBranch !== target.local) {
        branch = target.pushBranch
        open = await findOpenPullRequests(config, repo, branch)
      }
      // Mit bestätigtem Ziel zählt nur der PR dorthin; einer auf ein anderes Ziel bleibt unberührt.
      if (targetBranch) open = open.filter((pr) => pr.targetBranch === targetBranch)
      if (open.length === 0) {
        return await openPullRequest({
          config,
          repo,
          target,
          git,
          cwd: directory,
          title,
          targetBranch,
          rendered,
        })
      }
      if (open.length > 1) {
        return [
          `PR nicht geändert — Branch ${branch} hat ${open.length} offene PRs. Benutzer fragen, welcher gemeint ist,`,
          "dann pr_summary mit prUrl erneut aufrufen:",
          ...open.map(describePullRequest),
        ].join("\n")
      }
      id = open[0].id
    }

    const updated = await setDescription(config, repo, id, rendered.markdown)
    const lines = [
      `Description von PR #${updated.id} ersetzt (${repo.projectKey}/${repo.repoSlug} → ${updated.targetBranch}):`,
      `  ${updated.url}`,
    ]
    if (title) lines.push("PR bestand schon, title nicht verwendet.")
    appendWarnings(lines, rendered.warnings.map((w) => `${w.path}: ${w.message}`))
    return { content: lines.join("\n"), metadata: { title: `PR #${updated.id} — ${updated.title}`, url: updated.url } }
  } catch (error) {
    if (error instanceof UncertainOutcomeError) return `Ausgang unklar — ${error.message}`
    if (error instanceof BitbucketError) return `PR nicht geändert — ${error.message}`
    throw error
  }
}

function appendWarnings(lines: string[], warnings: string[]) {
  if (!warnings.length) return
  lines.push("", "Warnungen:")
  for (const w of warnings) lines.push(`  ${w}`)
}

type OpenRequest = {
  config: BitbucketConfig
  repo: RepoRef
  target: BranchTarget
  git: Git
  cwd: string
  title?: string
  targetBranch?: string
  rendered: ReturnType<typeof renderSummary>
}

/** Branch ohne offenen PR: Draft-PR mit der Zusammenfassung anlegen oder sagen, was dazu fehlt. */
async function openPullRequest(req: OpenRequest): Promise<string | Result> {
  const { config, repo, target, title, targetBranch } = req
  const source = target.pushBranch ?? target.local
  const where = `${repo.projectKey}/${repo.repoSlug}`
  if (MAIN_BRANCHES.has(source) || MAIN_BRANCHES.has(target.local)) {
    return `PR nicht angelegt — Quelle ist ${source}. Ein PR aus master/main ergibt keinen Sinn, Feature-Branch anlegen.`
  }
  if (!(await remoteRefExists(req.git, req.cwd, target.remoteName, source))) {
    return (
      `PR nicht angelegt — Branch ${source} ist nicht gepusht (oder anderswo gepusht und hier nicht geholt: git fetch). ` +
      "Erst pushen, dann erneut pr_summary."
    )
  }
  if (!title || !targetBranch) {
    const suggestion = await suggestTarget(req.git, req.cwd, target, source)
    return [
      `PR nicht geändert — kein offener PR für Branch ${source} in ${where}.`,
      "Zum Anlegen als Draft pr_summary erneut mit title und targetBranch aufrufen. Ist ein anderer PR gemeint: prUrl.",
      suggestion
        ? `Vorschlag Ziel: ${suggestion} (Basis des Branches). Benutzer fragen, ob der verwendet werden soll.`
        : "Ziel-Branch beim Benutzer erfragen, nie raten.",
    ].join("\n")
  }
  if (targetBranch === source || targetBranch === target.local) {
    return `PR nicht angelegt — Ziel ${targetBranch} ist zugleich die Quelle.`
  }

  const warnings: string[] = []
  try {
    const ahead = await req.git(["rev-list", "--count", `refs/remotes/${target.remoteName}/${source}..HEAD`], req.cwd)
    if (Number(ahead) > 0) warnings.push(`${ahead} lokale Commits nicht gepusht, fehlen im PR.`)
  } catch {
    // Ohne Vergleich keine Warnung; das Anlegen hängt nicht davon ab.
  }

  const repository = await getRepository(config, repo)
  let reviewers: Reviewer[] = []
  try {
    reviewers = await getDefaultReviewers(config, repository, source, targetBranch)
  } catch (error) {
    if (!(error instanceof BitbucketError)) throw error
    warnings.push(`Default-Reviewer nicht geladen, PR ohne Reviewer angelegt: ${error.message}`)
  }
  // Der Autor kann nicht eigener Reviewer sein. Ohne X-AUSERNAME bleibt die Liste ungefiltert.
  const author = repository.currentUser?.toLowerCase()
  if (author) reviewers = reviewers.filter((r) => r.user.name.toLowerCase() !== author)

  const created = await createPullRequest(config, repo, {
    title,
    description: req.rendered.markdown,
    fromBranch: source,
    toBranch: targetBranch,
    reviewers,
  })
  if (created.draft !== true) {
    warnings.push("Als normaler PR angelegt, nicht als Draft: die Instanz kennt keine Drafts (ab 8.18).")
  }
  const lines = [
    `${created.draft === true ? "Draft-PR" : "PR"} #${created.id} angelegt (${where}, ${source} → ${created.targetBranch}):`,
    `  ${created.url}`,
    `Reviewer: ${created.reviewers.map((r) => r.user.name).join(", ") || "keine"}`,
  ]
  appendWarnings(lines, [...warnings, ...req.rendered.warnings.map((w) => `${w.path}: ${w.message}`)])
  return { content: lines.join("\n"), metadata: { title: `PR #${created.id} — ${created.title}`, url: created.url } }
}

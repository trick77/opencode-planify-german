import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { tool } from "@opencode-ai/plugin"
import {
  BitbucketError,
  findOpenPullRequests,
  normalizeBaseUrl,
  parsePullRequestUrl,
  parseRemote,
  setDescription,
  type BitbucketConfig,
  type PullRequest,
  type RepoRef,
} from "./bitbucket.ts"
import { renderMarkdown } from "./render.ts"

const z = tool.schema

// Grenze für die Description. Wert unverifiziert: auf der eigenen Instanz messen und
// hier nachziehen. Darüber lehnt das Tool ab, statt Bitbucket kürzen zu lassen.
export const MAX_DESCRIPTION_LENGTH = 32_000

const INSTALL_HINT =
  "npx opencode-presets install opencode-planify-german-bitbucket " +
  "--set bitbucketUrl=https://<bitbucket-host> --set-env bitbucketToken=<ENV_VAR_MIT_TOKEN>"

export type PrToolOptions = {
  bitbucketUrl?: string
  bitbucketToken?: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  /** git-Aufruf überschreibbar für Tests. */
  git?: Git
}

type Git = (args: string[], cwd: string) => Promise<string>

// Asynchron: ein synchroner Aufruf blockiert den ganzen opencode-Prozess.
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolvePromise(stdout.trim())
    })
  })
}

type BranchTarget = { local: string; pushBranch?: string; remoteName: string }

/**
 * Lokaler Branch und, falls konfiguriert, wohin er gepusht wird. Bewusst nicht der
 * Upstream: nach "checkout -b feature origin/master" zeigt der auf master, und die
 * PR-Suche träfe einen fremden PR.
 */
async function branchTarget(git: Git, cwd: string): Promise<BranchTarget | undefined> {
  const local = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
  if (local === "HEAD") return undefined
  const push = await git(["for-each-ref", "--format=%(push:remotename)%00%(push)", `refs/heads/${local}`], cwd)
  const [remoteName, pushRef] = push.split("\0")
  const prefix = remoteName ? `refs/remotes/${remoteName}/` : ""
  const pushBranch = remoteName && pushRef?.startsWith(prefix) ? pushRef.slice(prefix.length) : undefined
  return { local, pushBranch, remoteName: remoteName || "origin" }
}

function describePullRequest(pr: PullRequest): string {
  return `  #${pr.id} → ${pr.targetBranch}: ${pr.title}\n    ${pr.url}`
}

/**
 * Baut das Tool `plan_pr`: schreibt einen gerenderten Plan als Markdown in die
 * Description eines offenen Bitbucket-Data-Center-PRs. Nur auf Anfrage des Benutzers.
 */
export function createPlanPrTool(options: PrToolOptions = {}) {
  return tool({
    description:
      "Schreibt einen bestehenden Plan (.plan.json von plan_render) als Markdown in die Description eines " +
      "offenen Bitbucket-Data-Center-Pull-Requests und ersetzt sie vollständig. Nie als Kommentar, legt nie einen PR an. " +
      "Nur aufrufen, wenn der Benutzer es verlangt. Ohne prUrl wird der offene PR des aktuellen Branches gesucht.",
    args: {
      path: z.string().describe("Pfad zur .plan.json, wie plan_render ihn gemeldet hat"),
      prUrl: z
        .string()
        .optional()
        .describe("PR-URL aus dem Browser. Nur nötig, wenn der Branch mehrere offene PRs hat oder ein anderer PR gemeint ist"),
    },
    async execute(args, context) {
      const env = options.env ?? process.env
      const git = options.git ?? runGit
      const token = options.bitbucketToken?.trim() || env.PLANIFY_BITBUCKET_TOKEN?.trim()
      const configuredUrl = options.bitbucketUrl?.trim() || env.PLANIFY_BITBUCKET_URL?.trim()

      if (!token) {
        return [
          "PR nicht geändert — kein Bitbucket-Token konfiguriert.",
          "Bundle mit Token installieren und opencode neu starten:",
          `  ${INSTALL_HINT}`,
          "Alternativ Umgebungsvariable PLANIFY_BITBUCKET_TOKEN setzen.",
        ].join("\n")
      }

      const planPath = isAbsolute(args.path) ? args.path : resolve(context.directory, args.path)
      let plan: any
      try {
        plan = JSON.parse(readFileSync(planPath, "utf8"))
      } catch (error) {
        return `PR nicht geändert — Plan nicht lesbar: ${planPath}: ${(error as Error).message}`
      }

      let rendered
      try {
        rendered = renderMarkdown(plan)
      } catch (error) {
        return `PR nicht geändert — ${(error as Error).message}\nPlan korrigieren, mit plan_render neu schreiben, dann erneut plan_pr.`
      }
      if (rendered.markdown.length > MAX_DESCRIPTION_LENGTH) {
        return (
          `PR nicht geändert — Description wäre ${rendered.markdown.length} Zeichen lang, ` +
          `Grenze ${MAX_DESCRIPTION_LENGTH}. Plan kürzen.`
        )
      }

      if (!configuredUrl) {
        return [
          "PR nicht geändert — keine Bitbucket-URL konfiguriert.",
          `Bundle mit URL installieren: ${INSTALL_HINT}`,
          "Alternativ Umgebungsvariable PLANIFY_BITBUCKET_URL setzen.",
        ].join("\n")
      }
      let baseUrl: string
      try {
        baseUrl = normalizeBaseUrl(configuredUrl)
      } catch {
        return `PR nicht geändert — Bitbucket-URL ungültig: ${configuredUrl}`
      }

      const config: BitbucketConfig = { baseUrl, token, fetch: options.fetch }
      let repo: RepoRef
      let id: number
      try {
        if (args.prUrl) {
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
          let target: BranchTarget | undefined
          let remote: string
          try {
            target = await branchTarget(git, context.directory)
            if (!target) {
              return "PR nicht geändert — kein Branch ausgecheckt (detached HEAD). Branch auschecken oder PR-URL angeben."
            }
            remote = await git(["remote", "get-url", target.remoteName], context.directory)
          } catch (error) {
            return `PR nicht geändert — git-Abfrage fehlgeschlagen: ${(error as Error).message}`
          }
          repo = parseRemote(remote)
          // Erst der lokale Name, dann das Push-Ziel, falls es anders heisst.
          let branch = target.local
          let open = await findOpenPullRequests(config, repo, branch)
          if (open.length === 0 && target.pushBranch && target.pushBranch !== target.local) {
            branch = target.pushBranch
            open = await findOpenPullRequests(config, repo, branch)
          }
          if (open.length === 0) {
            return [
              `PR nicht geändert — kein offener PR für Branch ${branch} in ${repo.projectKey}/${repo.repoSlug}.`,
              "Branch gepusht? PR im Bitbucket eröffnen, dann erneut plan_pr. Oder PR-URL angeben.",
            ].join("\n")
          }
          if (open.length > 1) {
            return [
              `PR nicht geändert — Branch ${branch} hat ${open.length} offene PRs. Benutzer fragen, welcher gemeint ist,`,
              "dann plan_pr mit prUrl erneut aufrufen:",
              ...open.map(describePullRequest),
            ].join("\n")
          }
          id = open[0].id
        }

        const updated = await setDescription(config, repo, id, rendered.markdown)
        context.metadata({ title: `PR #${updated.id} — ${updated.title}`, metadata: { url: updated.url, planPath } })
        const lines = [
          `Description von PR #${updated.id} ersetzt (${repo.projectKey}/${repo.repoSlug} → ${updated.targetBranch}):`,
          `  ${updated.url}`,
          `Quelle: ${planPath}`,
        ]
        if (rendered.warnings.length) {
          lines.push("", "Warnungen:")
          for (const w of rendered.warnings) lines.push(`  ${w.path}: ${w.message}`)
        }
        return lines.join("\n")
      } catch (error) {
        if (error instanceof BitbucketError) return `PR nicht geändert — ${error.message}`
        throw error
      }
    },
  })
}

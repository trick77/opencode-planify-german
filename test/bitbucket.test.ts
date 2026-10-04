import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { getPullRequest, parsePullRequestUrl, parseRemote, setDescription } from "../src/bitbucket.ts"
import { createPlanPrTool, MAX_DESCRIPTION_LENGTH } from "../src/tool-pr.ts"
import { root } from "../src/render.ts"

const BASE = "https://bitbucket.example.com"
const examplePath = resolve(root, "skills/planify/references/beispiel-plan.json")

type Call = { method: string; url: string; body?: any; auth?: string }

// Bitbucket-Attrappe: hält offene PRs im Speicher und protokolliert jeden Aufruf.
function fakeBitbucket(
  prs: any[],
  options: { conflictsOnce?: boolean } = {},
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  let conflicts = options.conflictsOnce ? 1 : 0
  const json = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url: input, body, auth: (init.headers as Record<string, string>).Authorization })
    const single = url.pathname.match(/\/pull-requests\/(\d+)$/)
    if (method === "GET" && url.pathname.endsWith("/pull-requests")) {
      const branch = url.searchParams.get("at")
      return json(200, { values: prs.filter((pr) => pr.fromRef.id === branch && pr.state === "OPEN") })
    }
    if (single) {
      const pr = prs.find((p) => p.id === Number(single[1]))
      if (!pr) return json(404, { errors: [{ message: "Pull request does not exist" }] })
      if (method === "GET") return json(200, pr)
      if (method === "PUT") {
        if (conflicts > 0) {
          conflicts--
          pr.version++
          return json(409, { errors: [{ message: "version mismatch" }] })
        }
        if (body.version !== pr.version) return json(409, { errors: [{ message: "version mismatch" }] })
        Object.assign(pr, { description: body.description, title: body.title, version: pr.version + 1 })
        return json(200, pr)
      }
    }
    return json(404, { errors: [{ message: "unexpected" }] })
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

function pullRequest(id: number, branch: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    version: 3,
    state: "OPEN",
    title: `PR ${id}`,
    description: "alt",
    fromRef: { id: `refs/heads/${branch}` },
    toRef: { displayId: "master" },
    reviewers: [{ user: { name: "reviewer" } }],
    links: { self: [{ href: `${BASE}/projects/PROJ/repos/app/pull-requests/${id}` }] },
    ...overrides,
  }
}

function planFile(change?: (plan: any) => void): string {
  const plan = JSON.parse(readFileSync(examplePath, "utf8"))
  change?.(plan)
  const dir = mkdtempSync(resolve(tmpdir(), "planify-pr-"))
  const path = resolve(dir, "plan.plan.json")
  writeFileSync(path, JSON.stringify(plan), "utf8")
  return path
}

function runTool(
  args: { path: string; prUrl?: string },
  options: Parameters<typeof createPlanPrTool>[0],
  git: Record<string, string> = {
    "rev-parse": "feature/SEP-1-x",
    "for-each-ref": "origin\0refs/remotes/origin/feature/SEP-1-x",
    remote: "ssh://git@bitbucket.example.com:7999/proj/app.git",
  },
) {
  const tool = createPlanPrTool({
    bitbucketUrl: BASE,
    bitbucketToken: "geheim",
    env: {},
    git: async (gitArgs) => {
      const answer = git[gitArgs[0]]
      if (answer === undefined) throw new Error(`git ${gitArgs.join(" ")} fehlgeschlagen`)
      return answer
    },
    ...options,
  })
  const context = { directory: "/projekt", metadata: () => {} } as never
  return tool.execute(args as never, context) as Promise<string>
}

test("Remote-URL ergibt Projekt und Repository für https, ssh und persönliche Repos", () => {
  // When / Then
  assert.deepEqual(parseRemote("https://bitbucket.example.com/scm/PROJ/app.git"), { projectKey: "PROJ", repoSlug: "app" })
  assert.deepEqual(parseRemote("https://host/bitbucket/scm/PROJ/app.git"), { projectKey: "PROJ", repoSlug: "app" })
  assert.deepEqual(parseRemote("ssh://git@host:7999/proj/app.git"), { projectKey: "proj", repoSlug: "app" })
  assert.deepEqual(parseRemote("git@host:proj/app.git"), { projectKey: "proj", repoSlug: "app" })
  assert.deepEqual(parseRemote("ssh://git@host:7999/~jan/app.git"), { projectKey: "~jan", repoSlug: "app" })
  assert.throws(() => parseRemote("nicht-eine-url"), /nicht erkannt/)
  assert.throws(() => parseRemote("git@host:proj/re%po.git"), /nicht erkannt/)
})

test("PR-URL aus dem Browser wird zerlegt, auch mit Kontextpfad und Benutzer-Repo", () => {
  // When / Then
  assert.deepEqual(parsePullRequestUrl(`${BASE}/projects/PROJ/repos/app/pull-requests/12/overview`), {
    baseUrl: BASE,
    projectKey: "PROJ",
    repoSlug: "app",
    id: 12,
  })
  assert.equal(parsePullRequestUrl("https://host/bitbucket/projects/P/repos/r/pull-requests/1").baseUrl, "https://host/bitbucket")
  assert.equal(parsePullRequestUrl(`${BASE}/users/jan/repos/app/pull-requests/5`).projectKey, "~jan")
  assert.throws(() => parsePullRequestUrl(`${BASE}/projects/PROJ/repos/app/browse`), /nicht erkannt/)
})

test("Description wird ersetzt, Titel und Reviewer gehen unverändert mit", async () => {
  // Given
  const prs = [pullRequest(7, "feature/SEP-1-x")]
  const bitbucket = fakeBitbucket(prs)

  // When
  const result = await runTool({ path: planFile() }, { fetch: bitbucket.fetch })

  // Then
  assert.match(result, /Description von PR #7 ersetzt/)
  const put = bitbucket.calls.find((c) => c.method === "PUT")!
  assert.equal(put.url, `${BASE}/rest/api/latest/projects/proj/repos/app/pull-requests/7`)
  assert.equal(put.body.version, 3)
  assert.equal(put.body.title, "PR 7")
  assert.deepEqual(put.body.reviewers, [{ user: { name: "reviewer" } }])
  assert.match(put.body.description, /^# MapStruct-Mapper/)
  assert.equal(put.auth, "Bearer geheim")
  assert.equal(prs[0].title, "PR 7")
  assert.ok(!bitbucket.calls.some((c) => c.method === "POST"), "kein PR angelegt, kein Kommentar")
})

test("Versionskonflikt überschreibt nichts und wird gemeldet", async () => {
  // Given
  const prs = [pullRequest(7, "feature/SEP-1-x")]
  const bitbucket = fakeBitbucket(prs, { conflictsOnce: true })
  const config = { baseUrl: BASE, token: "t", fetch: bitbucket.fetch }

  // When / Then
  await assert.rejects(
    setDescription(config, { projectKey: "PROJ", repoSlug: "app" }, 7, "neu"),
    /gerade von jemand anderem geändert, nichts überschrieben/,
  )
  assert.equal(bitbucket.calls.filter((c) => c.method === "PUT").length, 1)
  assert.equal(prs[0].description, "alt")
})

test("Bitbucket ohne Antwort bricht nach dem Timeout ab", async () => {
  // Given: Verbindung steht, Antwort kommt nie. Der Timer von AbortSignal.timeout
  // hält die Event-Loop nicht offen, das Intervall schon, sonst bricht node:test ab.
  const hanging = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1000)
      init.signal?.addEventListener("abort", () => {
        clearInterval(keepAlive)
        reject(init.signal!.reason)
      })
    })) as typeof fetch
  const config = { baseUrl: BASE, token: "t", fetch: hanging, timeoutMs: 50 }

  // When / Then
  await assert.rejects(getPullRequest(config, { projectKey: "PROJ", repoSlug: "app" }, 7), /antwortet nicht innerhalb von 0.05 s/)
})

test("PR-Suche nimmt das Push-Ziel, wenn der lokale Branch anders heisst", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(7, "feature/SEP-1-lang")])

  // When
  const result = await runTool({ path: planFile() }, { fetch: bitbucket.fetch }, {
    "rev-parse": "kurz",
    "for-each-ref": "origin\0refs/remotes/origin/feature/SEP-1-lang",
    remote: "ssh://git@bitbucket.example.com:7999/proj/app.git",
  })

  // Then
  assert.match(result, /PR #7 ersetzt/)
  assert.ok(bitbucket.calls.some((c) => c.url.includes(encodeURIComponent("refs/heads/feature/SEP-1-lang"))))
})

// checkout -b feature origin/master setzt master als Upstream. Der Upstream darf
// nie die Suche bestimmen, sonst träfe sie einen fremden PR mit Quelle master.
test("Upstream master führt nie zum PR von master", async () => {
  // Given
  const prs = [pullRequest(5, "master", { title: "Release" })]
  const bitbucket = fakeBitbucket(prs)

  // When
  const result = await runTool({ path: planFile() }, { fetch: bitbucket.fetch }, {
    "rev-parse": "feature/neu",
    "for-each-ref": "origin\0refs/remotes/origin/feature/neu",
    remote: "ssh://git@bitbucket.example.com:7999/proj/app.git",
  })

  // Then
  assert.match(result, /kein offener PR für Branch feature\/neu/)
  assert.ok(!bitbucket.calls.some((c) => c.method === "PUT"))
  assert.equal(prs[0].description, "alt")
})

test("2xx ohne JSON wird als Anmeldeproblem gemeldet, nicht als fehlender PR", async () => {
  // Given: SSO-Proxy liefert eine Login-Seite mit 200
  const loginPage = (async () => new Response("<html>Login</html>", { status: 200 })) as typeof fetch

  // When
  const result = await runTool({ path: planFile() }, { fetch: loginPage })

  // Then
  assert.match(result, /ohne JSON \(Login-Seite eines Proxys\?/)
  assert.doesNotMatch(result, /kein offener PR/)
})

test("unbrauchbare Antwort auf das PUT sagt, dass der PR zu prüfen ist", async () => {
  // Given
  const prs = [pullRequest(7, "feature/SEP-1-x")]
  const real = fakeBitbucket(prs)
  const emptyPut = (async (input: string, init: RequestInit = {}) =>
    init.method === "PUT" ? new Response(null, { status: 204 }) : real.fetch(input, init)) as typeof fetch

  // When
  const result = await runTool({ path: planFile() }, { fetch: emptyPut })

  // Then
  assert.match(result, /im PR #7 prüfen/)
})

test("Reviewer ohne Namen gehen nicht ins PUT", async () => {
  // Given
  const prs = [pullRequest(7, "feature/SEP-1-x", { reviewers: [{ user: { name: "a" } }, { user: {} }, {}] })]
  const bitbucket = fakeBitbucket(prs)

  // When
  await runTool({ path: planFile() }, { fetch: bitbucket.fetch })

  // Then
  const put = bitbucket.calls.find((c) => c.method === "PUT")!
  assert.deepEqual(put.body.reviewers, [{ user: { name: "a" } }])
})

test("Branch ohne offenen PR ändert nichts und nennt den nächsten Schritt", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(7, "anderer-branch")])

  // When
  const result = await runTool({ path: planFile() }, { fetch: bitbucket.fetch })

  // Then
  assert.match(result, /kein offener PR für Branch feature\/SEP-1-x in proj\/app/)
  assert.match(result, /Branch gepusht\?/)
  assert.ok(!bitbucket.calls.some((c) => c.method === "PUT"))
})

test("mehrere offene PRs werden aufgelistet statt geraten", async () => {
  // Given
  const bitbucket = fakeBitbucket([
    pullRequest(7, "feature/SEP-1-x"),
    pullRequest(8, "feature/SEP-1-x", { toRef: { displayId: "release/1.0" } }),
  ])

  // When
  const result = await runTool({ path: planFile() }, { fetch: bitbucket.fetch })

  // Then
  assert.match(result, /2 offene PRs/)
  assert.match(result, /#7 → master/)
  assert.match(result, /#8 → release\/1\.0/)
  assert.ok(!bitbucket.calls.some((c) => c.method === "PUT"))
})

test("PR-URL wählt den PR direkt, ohne Branch-Suche", async () => {
  // Given
  const prs = [pullRequest(8, "feature/SEP-1-x")]
  const bitbucket = fakeBitbucket(prs)

  // When
  const result = await runTool(
    { path: planFile(), prUrl: `${BASE}/projects/PROJ/repos/app/pull-requests/8` },
    { fetch: bitbucket.fetch },
    {},
  )

  // Then
  assert.match(result, /PR #8 ersetzt/)
  assert.ok(!bitbucket.calls.some((c) => c.url.includes("?at=")))
})

test("Token geht nie an einen Host ausserhalb der konfigurierten Instanz", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(1, "x")])

  // When
  const result = await runTool(
    { path: planFile(), prUrl: "https://attacker.example/projects/X/repos/y/pull-requests/1" },
    { fetch: bitbucket.fetch },
  )

  // Then
  assert.match(result, /nur an die konfigurierte Bitbucket-Instanz/)
  assert.equal(bitbucket.calls.length, 0)
})

test("gemergter PR wird nicht angefasst", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(9, "x", { state: "MERGED" })])

  // When
  const result = await runTool({ path: planFile(), prUrl: `${BASE}/projects/PROJ/repos/app/pull-requests/9` }, { fetch: bitbucket.fetch })

  // Then
  assert.match(result, /PR #9 ist MERGED/)
  assert.ok(!bitbucket.calls.some((c) => c.method === "PUT"))
})

test("ohne Token oder URL kein Aufruf, dafür der Installationsbefehl", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(7, "feature/SEP-1-x")])

  // When
  const withoutToken = await runTool({ path: planFile() }, { fetch: bitbucket.fetch, bitbucketToken: undefined })
  const withoutUrl = await runTool({ path: planFile() }, { fetch: bitbucket.fetch, bitbucketUrl: undefined })

  // Then
  assert.match(withoutToken, /kein Bitbucket-Token/)
  assert.match(withoutToken, /opencode-presets install opencode-planify-german --set bitbucketUrl=/)
  assert.match(withoutUrl, /keine Bitbucket-URL/)
  assert.equal(bitbucket.calls.length, 0)
})

test("Umgebungsvariablen ersetzen fehlende Plugin-Optionen", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(7, "feature/SEP-1-x")])

  // When
  const result = await runTool(
    { path: planFile() },
    {
      fetch: bitbucket.fetch,
      bitbucketUrl: undefined,
      bitbucketToken: undefined,
      env: { PLANIFY_BITBUCKET_URL: `${BASE}/`, PLANIFY_BITBUCKET_TOKEN: "aus-env" },
    },
  )

  // Then
  assert.match(result, /PR #7 ersetzt/)
  assert.equal(bitbucket.calls[0].auth, "Bearer aus-env")
})

test("detached HEAD ändert nichts", async () => {
  // Given
  const bitbucket = fakeBitbucket([])

  // When
  const result = await runTool({ path: planFile() }, { fetch: bitbucket.fetch }, { "rev-parse": "HEAD", remote: "git@h:p/r.git" })

  // Then
  assert.match(result, /detached HEAD/)
  assert.equal(bitbucket.calls.length, 0)
})

test("ungültiger oder zu langer Plan erreicht Bitbucket nicht", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(7, "feature/SEP-1-x")])
  const invalid = planFile((plan) => delete plan.verification)
  const tooLong = planFile((plan) => (plan.intent = "x".repeat(MAX_DESCRIPTION_LENGTH)))

  // When
  const invalidResult = await runTool({ path: invalid }, { fetch: bitbucket.fetch })
  const tooLongResult = await runTool({ path: tooLong }, { fetch: bitbucket.fetch })

  // Then
  assert.match(invalidResult, /nicht schemakonform/)
  assert.match(tooLongResult, /Grenze/)
  assert.equal(bitbucket.calls.length, 0)
})

test("Warnungen nennen Pfad und Meldung", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(7, "feature/SEP-1-x")])
  const withDiagram = planFile((plan) => (plan.diagram = { title: "Ablauf", svgPath: "fehlt.svg" }))

  // When
  const result = await runTool({ path: withDiagram }, { fetch: bitbucket.fetch })

  // Then
  assert.match(result, /\/diagram: Diagramm nicht in der PR-Description/)
  assert.doesNotMatch(result, /undefined/)
})

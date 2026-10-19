import { test } from "node:test"
import assert from "node:assert/strict"
import { getPullRequest, parsePullRequestUrl, parseRemote, setDescription } from "../src/bitbucket.ts"
import { createPrSummaryTool, MAX_DESCRIPTION_LENGTH } from "../src/tool-pr.ts"

const BASE = "https://bitbucket.example.com"

type Call = { method: string; url: string; body?: any; auth?: string }

// Bitbucket-Attrappe: hält offene PRs im Speicher und protokolliert jeden Aufruf.
function fakeBitbucket(
  prs: any[],
  options: {
    conflictsOnce?: boolean
    defaultReviewers?: string[]
    defaultReviewersStatus?: number
    username?: string
    drafts?: boolean
    createStatus?: number
  } = {},
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  let conflicts = options.conflictsOnce ? 1 : 0
  const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } })
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url: input, body, auth: (init.headers as Record<string, string>).Authorization })
    const single = url.pathname.match(/\/pull-requests\/(\d+)$/)
    if (method === "GET" && /\/rest\/api\/latest\/projects\/[^/]+\/repos\/[^/]+$/.test(url.pathname)) {
      return json(200, { id: 42, slug: "app" }, options.username ? { "X-AUSERNAME": options.username } : {})
    }
    if (method === "GET" && url.pathname.startsWith("/rest/default-reviewers/")) {
      if (options.defaultReviewersStatus) return json(options.defaultReviewersStatus, { errors: [{ message: "nope" }] })
      return json(200, (options.defaultReviewers ?? []).map((name) => ({ name })))
    }
    if (method === "POST" && url.pathname.endsWith("/pull-requests")) {
      if (options.createStatus) return json(options.createStatus, { errors: [{ message: "verboten" }] })
      const created = pullRequest(100, body.fromRef.id.replace("refs/heads/", ""), {
        title: body.title,
        description: body.description,
        toRef: { displayId: body.toRef.id.replace("refs/heads/", "") },
        reviewers: body.reviewers,
        ...(options.drafts === false ? {} : { draft: body.draft }),
      })
      prs.push(created)
      return json(201, created)
    }
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

const SUMMARY = [
  "Aufgabe: die Mapper von Hand auf MapStruct umstellen.",
  "Problem: die handgeschriebenen Mapper laufen bei jedem neuen Feld auseinander.",
  "Lösung: MapStruct generiert die Mapper beim Build, ein Test prüft fehlende Felder.",
].join("\n\n")

function fakeGit(answers: Record<string, string | null>) {
  return async (gitArgs: string[]) => {
    const key = [gitArgs.join(" "), `${gitArgs[0]} ${gitArgs[1]}`, gitArgs[0]].find((k) => k in answers)
    const answer = key === undefined ? undefined : answers[key]
    if (answer == null) throw new Error(`git ${gitArgs.join(" ")} fehlgeschlagen`)
    return answer
  }
}

function runTool(
  args: { summary: string; prUrl?: string; title?: string; targetBranch?: string },
  options: Partial<Parameters<typeof createPrSummaryTool>[0]>,
  // Ganzer Aufruf vor "befehl option" vor "befehl"; null lässt den Aufruf scheitern.
  git: Record<string, string | null> = {
    "rev-parse": "feature/SEP-1-x",
    "for-each-ref": "origin\0refs/remotes/origin/feature/SEP-1-x",
    remote: "ssh://git@bitbucket.example.com:7999/proj/app.git",
  },
) {
  const tool = createPrSummaryTool({
    directory: () => "/projekt",
    bitbucketUrl: BASE,
    bitbucketToken: "geheim",
    env: {},
    git: fakeGit(git),
    ...options,
  })
  return tool.execute(args as never, {} as never).then((result) => result.content as string)
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
  const result = await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch })

  // Then
  assert.match(result, /Description von PR #7 ersetzt/)
  const put = bitbucket.calls.find((c) => c.method === "PUT")!
  assert.equal(put.url, `${BASE}/rest/api/latest/projects/proj/repos/app/pull-requests/7`)
  assert.equal(put.body.version, 3)
  assert.equal(put.body.title, "PR 7")
  assert.deepEqual(put.body.reviewers, [{ user: { name: "reviewer" } }])
  assert.equal(put.body.description, SUMMARY + "\n")
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

test("Abbruch der Sitzung bricht die Bitbucket-Anfrage ab, ohne Timeout-Meldung", async () => {
  // Given
  const hanging = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1000)
      init.signal?.addEventListener("abort", () => {
        clearInterval(keepAlive)
        reject(init.signal!.reason)
      })
    })) as typeof fetch
  const controller = new AbortController()
  const tool = createPrSummaryTool({
    directory: () => "/projekt",
    bitbucketUrl: BASE,
    bitbucketToken: "t",
    env: {},
    fetch: hanging,
    git: fakeGit({
      "rev-parse": "feature/SEP-1-x",
      "for-each-ref": "origin\0refs/remotes/origin/feature/SEP-1-x",
      remote: "ssh://git@bitbucket.example.com:7999/proj/app.git",
    }),
  })

  // When
  const pending = tool.execute({ summary: SUMMARY } as never, { signal: controller.signal } as never)
  setTimeout(() => controller.abort(), 20)

  // Then
  await assert.rejects(pending, (error: Error) => error.name === "AbortError" && !/innerhalb/.test(error.message))
})

test("pr_summary fragt git im Verzeichnis der aufrufenden Sitzung", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(7, "feature/SEP-1-x")])
  const cwds: string[] = []
  const answers = fakeGit({
    "rev-parse": "feature/SEP-1-x",
    "for-each-ref": "origin\0refs/remotes/origin/feature/SEP-1-x",
    remote: "ssh://git@bitbucket.example.com:7999/proj/app.git",
  })
  const tool = createPrSummaryTool({
    directory: (context) => `/worktrees/${context.sessionID}`,
    bitbucketUrl: BASE,
    bitbucketToken: "t",
    env: {},
    fetch: bitbucket.fetch,
    git: (gitArgs, cwd) => {
      cwds.push(cwd)
      return answers(gitArgs)
    },
  })

  // When
  const result = await tool.execute({ summary: SUMMARY } as never, { sessionID: "ses_b" } as never)

  // Then
  assert.match(result.content as string, /Description von PR #7 ersetzt/)
  assert.equal(result.metadata?.title, "PR #7 — PR 7")
  assert.ok(cwds.length > 0)
  assert.ok(cwds.every((cwd) => cwd === "/worktrees/ses_b"))
})

test("PR-Suche nimmt das Push-Ziel, wenn der lokale Branch anders heisst", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(7, "feature/SEP-1-lang")])

  // When
  const result = await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch }, {
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
  const result = await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch }, {
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
  const result = await runTool({ summary: SUMMARY }, { fetch: loginPage })

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
  const result = await runTool({ summary: SUMMARY }, { fetch: emptyPut })

  // Then
  assert.match(result, /im PR #7 prüfen/)
})

test("Reviewer ohne Namen gehen nicht ins PUT", async () => {
  // Given
  const prs = [pullRequest(7, "feature/SEP-1-x", { reviewers: [{ user: { name: "a" } }, { user: {} }, {}] })]
  const bitbucket = fakeBitbucket(prs)

  // When
  await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch })

  // Then
  const put = bitbucket.calls.find((c) => c.method === "PUT")!
  assert.deepEqual(put.body.reviewers, [{ user: { name: "a" } }])
})

test("Branch ohne offenen PR ändert nichts und nennt den nächsten Schritt", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(7, "anderer-branch")])

  // When
  const result = await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch })

  // Then
  assert.match(result, /kein offener PR für Branch feature\/SEP-1-x in proj\/app/)
  assert.match(result, /mit title und targetBranch/)
  assert.match(result, /Ziel-Branch beim Benutzer erfragen, nie raten/)
  assert.ok(!bitbucket.calls.some((c) => c.method === "PUT" || c.method === "POST"))
})

// Zustand nach "checkout -b feature/SEP-1-x origin/release-2.3" und "push -u": Push-Ziel
// und Upstream zeigen auf den Branch selbst, die Basis steht nur noch im Reflog.
const FEATURE_GIT: Record<string, string | null> = {
  "rev-parse --abbrev-ref": "feature/SEP-1-x",
  "rev-parse --verify": "abc123",
  "for-each-ref": "origin\0refs/remotes/origin/feature/SEP-1-x\0origin\0refs/remotes/origin/feature/SEP-1-x",
  reflog: "commit: zwei\ncommit: eins\nbranch: Created from origin/release-2.3",
  remote: "ssh://git@bitbucket.example.com:7999/proj/app.git",
  "rev-list": "0",
}

// Nach "push" ohne -u bei push.default=simple: %(push) leer, Upstream noch die Basis.
const PUSHED_WITHOUT_U = {
  ...FEATURE_GIT,
  "for-each-ref": "origin\0\0origin\0refs/remotes/origin/release-2.3",
  reflog: null,
}

test("ohne PR legt das Tool einen Draft mit Description und Default-Reviewern an, ohne den Autor", async () => {
  // Given
  const prs: any[] = []
  const bitbucket = fakeBitbucket(prs, { defaultReviewers: ["jan", "anna", "beat"], username: "jan" })

  // When
  const result = await runTool({ summary: SUMMARY, title: "SEP-1 Mapper", targetBranch: "release-2.3" }, { fetch: bitbucket.fetch }, FEATURE_GIT)

  // Then
  assert.match(result, /Draft-PR #100 angelegt \(proj\/app, feature\/SEP-1-x → release-2\.3\)/)
  assert.match(result, /Reviewer: anna, beat/)
  assert.doesNotMatch(result, /Warnungen/)
  const post = bitbucket.calls.find((c) => c.method === "POST")!
  assert.equal(post.url, `${BASE}/rest/api/latest/projects/proj/repos/app/pull-requests`)
  assert.equal(post.body.draft, true)
  assert.equal(post.body.title, "SEP-1 Mapper")
  assert.equal(post.body.description, SUMMARY + "\n")
  assert.equal(post.body.fromRef.id, "refs/heads/feature/SEP-1-x")
  assert.equal(post.body.toRef.id, "refs/heads/release-2.3")
  assert.deepEqual(post.body.toRef.repository, { slug: "app", project: { key: "proj" } })
  assert.deepEqual(post.body.reviewers, [{ user: { name: "anna" } }, { user: { name: "beat" } }])
  const reviewerQuery = new URL(bitbucket.calls.find((c) => c.url.includes("default-reviewers"))!.url).searchParams
  assert.equal(reviewerQuery.get("sourceRepoId"), "42")
  assert.equal(reviewerQuery.get("targetRefId"), "refs/heads/release-2.3")
})

test("ohne title und targetBranch nur ein Vorschlag: die Basis des Branches, nie master/main", async () => {
  // Given
  const bitbucket = fakeBitbucket([])

  // When
  const fromRelease = await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch }, FEATURE_GIT)
  const fromMaster = await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch }, {
    ...FEATURE_GIT,
    reflog: "branch: Created from origin/master",
  })
  const withoutU = await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch }, PUSHED_WITHOUT_U)
  const onlyTitle = await runTool({ summary: SUMMARY, title: "T" }, { fetch: bitbucket.fetch }, FEATURE_GIT)

  // Then
  assert.match(fromRelease, /Vorschlag Ziel: release-2\.3/)
  assert.match(fromRelease, /Benutzer fragen, ob der verwendet werden soll/)
  assert.match(withoutU, /Vorschlag Ziel: release-2\.3/)
  assert.doesNotMatch(fromMaster, /Vorschlag/)
  assert.match(fromMaster, /Ziel-Branch beim Benutzer erfragen, nie raten/)
  assert.match(onlyTitle, /Vorschlag Ziel: release-2\.3/)
  assert.ok(!bitbucket.calls.some((c) => c.method === "POST"))
})

test("aus master/main, ohne Push oder mit Ziel gleich Quelle wird nichts angelegt", async () => {
  // Given
  const bitbucket = fakeBitbucket([])
  const args = { summary: SUMMARY, title: "T", targetBranch: "develop" }

  // When
  const onMaster = await runTool(args, { fetch: bitbucket.fetch }, {
    ...FEATURE_GIT,
    "rev-parse --abbrev-ref": "master",
    "for-each-ref": "origin\0refs/remotes/origin/master",
  })
  const notPushed = await runTool(args, { fetch: bitbucket.fetch }, {
    ...FEATURE_GIT,
    "rev-parse --verify --quiet refs/remotes/origin/feature/SEP-1-x": null,
  })
  const sameBranch = await runTool({ ...args, targetBranch: "feature/SEP-1-x" }, { fetch: bitbucket.fetch }, FEATURE_GIT)

  // Then
  assert.match(onMaster, /Quelle ist master\. Ein PR aus master\/main ergibt keinen Sinn/)
  assert.match(notPushed, /nicht gepusht/)
  assert.match(sameBranch, /zugleich die Quelle/)
  assert.ok(!bitbucket.calls.some((c) => c.method === "POST"))
})

test("Default-Reviewer nicht ladbar: PR ohne Reviewer, mit Warnung", async () => {
  // Given
  const bitbucket = fakeBitbucket([], { defaultReviewersStatus: 404 })

  // When
  const result = await runTool({ summary: SUMMARY, title: "T", targetBranch: "develop" }, { fetch: bitbucket.fetch }, FEATURE_GIT)

  // Then
  assert.match(result, /Draft-PR #100 angelegt/)
  assert.match(result, /Reviewer: keine/)
  assert.match(result, /Default-Reviewer nicht geladen/)
  assert.deepEqual(bitbucket.calls.find((c) => c.method === "POST")!.body.reviewers, [])
})

test("Instanz ohne Drafts und ungepushte Commits ergeben Warnungen", async () => {
  // Given
  const bitbucket = fakeBitbucket([], { drafts: false })

  // When
  const result = await runTool(
    { summary: SUMMARY, title: "T", targetBranch: "develop" },
    { fetch: bitbucket.fetch },
    { ...FEATURE_GIT, "rev-list": "2" },
  )

  // Then
  assert.match(result, /^PR #100 angelegt/)
  assert.match(result, /nicht als Draft/)
  assert.match(result, /2 lokale Commits nicht gepusht/)
})

test("bestehender PR aufs bestätigte Ziel: nichts angelegt, die Description wird ersetzt", async () => {
  // Given
  const prs = [pullRequest(7, "feature/SEP-1-x")]
  const bitbucket = fakeBitbucket(prs)

  // When
  const result = await runTool({ summary: SUMMARY, title: "T", targetBranch: "origin/master" }, { fetch: bitbucket.fetch }, {
    ...FEATURE_GIT,
    "rev-parse --verify --quiet refs/remotes/origin/origin/master": null,
  })
  const withUrl = await runTool(
    { summary: SUMMARY, title: "T", prUrl: `${BASE}/projects/PROJ/repos/app/pull-requests/7` },
    { fetch: bitbucket.fetch },
  )

  // Then
  assert.match(result, /Description von PR #7 ersetzt/)
  assert.match(result, /title nicht verwendet/)
  assert.match(withUrl, /prUrl meint einen bestehenden PR/)
  assert.ok(!bitbucket.calls.some((c) => c.method === "POST"))
})

test("bestehender PR auf ein anderes Ziel bleibt unberührt, der neue PR wird angelegt", async () => {
  // Given
  const prs = [pullRequest(7, "feature/SEP-1-x")]
  const bitbucket = fakeBitbucket(prs)

  // When
  const result = await runTool({ summary: SUMMARY, title: "T", targetBranch: "release-2.3" }, { fetch: bitbucket.fetch }, FEATURE_GIT)

  // Then
  assert.match(result, /Draft-PR #100 angelegt/)
  assert.ok(!bitbucket.calls.some((c) => c.method === "PUT"))
  assert.equal(prs[0].description, "alt")
})

test("unbekannter Ziel-Branch wird vor jedem Bitbucket-Aufruf abgelehnt", async () => {
  // Given
  const bitbucket = fakeBitbucket([])

  // When
  const result = await runTool(
    { summary: SUMMARY, title: "T", targetBranch: "relase-2.3" },
    { fetch: bitbucket.fetch },
    { ...FEATURE_GIT, "rev-parse --verify": null },
  )

  // Then
  assert.match(result, /Ziel-Branch relase-2\.3 gibt es auf origin nicht/)
  assert.equal(bitbucket.calls.length, 0)
})

test("Draft bleibt beim Ersetzen der Description ein Draft", async () => {
  // Given
  const prs = [pullRequest(7, "feature/SEP-1-x", { draft: true })]
  const bitbucket = fakeBitbucket(prs)

  // When
  await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch })

  // Then
  assert.equal(bitbucket.calls.find((c) => c.method === "PUT")!.body.draft, true)
})

test("Timeout beim Anlegen meldet einen unklaren Ausgang, nicht 'nicht geändert'", async () => {
  // Given
  const real = fakeBitbucket([])
  const slowPost = (async (input: string, init: RequestInit = {}) => {
    if (init.method !== "POST") return real.fetch(input, init)
    await new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
  }) as typeof fetch
  const keepAlive = setInterval(() => {}, 1000)

  // When
  const result = await runTool(
    { summary: SUMMARY, title: "T", targetBranch: "develop" },
    { fetch: slowPost, timeoutMs: 50 },
    FEATURE_GIT,
  )
  clearInterval(keepAlive)

  // Then
  assert.match(result, /^Ausgang unklar — Bitbucket antwortet nicht/)
  assert.match(result, /bevor erneut angelegt wird/)
})

test("Autor wird ohne Rücksicht auf Gross-/Kleinschreibung aus den Reviewern gefiltert", async () => {
  // Given
  const bitbucket = fakeBitbucket([], { defaultReviewers: ["jdoe", "anna"], username: "JDoe" })

  // When
  await runTool({ summary: SUMMARY, title: "T", targetBranch: "develop" }, { fetch: bitbucket.fetch }, FEATURE_GIT)

  // Then
  assert.deepEqual(bitbucket.calls.find((c) => c.method === "POST")!.body.reviewers, [{ user: { name: "anna" } }])
})

test("'Created from HEAD' nimmt die Basis aus dem Reflog von HEAD", async () => {
  // Given: git checkout release-2.3 && git checkout -b feature/SEP-1-x
  const bitbucket = fakeBitbucket([])
  const reflogs: Record<string, string> = {
    "refs/heads/feature/SEP-1-x": "commit: eins\nbranch: Created from HEAD",
    HEAD: [
      "checkout: moving from master to feature/SEP-1-x",
      "commit: eins",
      "checkout: moving from release-2.3 to feature/SEP-1-x",
      "checkout: moving from master to release-2.3",
    ].join("\n"),
  }
  const tool = createPrSummaryTool({
    directory: () => "/p",
    bitbucketUrl: BASE,
    bitbucketToken: "t",
    env: {},
    fetch: bitbucket.fetch,
    git: async (gitArgs) => (gitArgs[0] === "reflog" ? reflogs[gitArgs[3]] : fakeGit(FEATURE_GIT)(gitArgs)),
  })

  // When
  const result = (await tool.execute({ summary: SUMMARY } as never, {} as never)).content as string

  // Then
  assert.match(result, /Vorschlag Ziel: release-2\.3/)
})

test("Anlegen ohne Schreibrecht nennt das Recht", async () => {
  // Given
  const bitbucket = fakeBitbucket([], { createStatus: 403 })

  // When
  const result = await runTool({ summary: SUMMARY, title: "T", targetBranch: "develop" }, { fetch: bitbucket.fetch }, FEATURE_GIT)

  // Then
  assert.match(result, /PR nicht geändert — Bitbucket antwortet 403/)
  assert.match(result, /Schreibrecht auf das Repository/)
})

test("mehrere offene PRs werden aufgelistet statt geraten", async () => {
  // Given
  const bitbucket = fakeBitbucket([
    pullRequest(7, "feature/SEP-1-x"),
    pullRequest(8, "feature/SEP-1-x", { toRef: { displayId: "release/1.0" } }),
  ])

  // When
  const result = await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch })

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
    { summary: SUMMARY, prUrl: `${BASE}/projects/PROJ/repos/app/pull-requests/8` },
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
    { summary: SUMMARY, prUrl: "https://attacker.example/projects/X/repos/y/pull-requests/1" },
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
  const result = await runTool({ summary: SUMMARY, prUrl: `${BASE}/projects/PROJ/repos/app/pull-requests/9` }, { fetch: bitbucket.fetch })

  // Then
  assert.match(result, /PR #9 ist MERGED/)
  assert.ok(!bitbucket.calls.some((c) => c.method === "PUT"))
})

test("ohne Token oder URL kein Aufruf, dafür der Installationsbefehl", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(7, "feature/SEP-1-x")])

  // When
  const withoutToken = await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch, bitbucketToken: undefined })
  const withoutUrl = await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch, bitbucketUrl: undefined })

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
    { summary: SUMMARY },
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
  const result = await runTool({ summary: SUMMARY }, { fetch: bitbucket.fetch }, { "rev-parse": "HEAD", remote: "git@h:p/r.git" })

  // Then
  assert.match(result, /detached HEAD/)
  assert.equal(bitbucket.calls.length, 0)
})

test("falsche Absatzzahl oder zu lange Zusammenfassung erreicht Bitbucket nicht", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(7, "feature/SEP-1-x")])
  const tooFew = "Erster Absatz.\n\nZweiter Absatz."
  const tooMany = "A.\n\nB.\n\nC.\n\nD.\n\nE."
  const tooLong = SUMMARY + " " + "x".repeat(MAX_DESCRIPTION_LENGTH)

  // When
  const results = await Promise.all(
    [tooFew, tooMany, tooLong].map((summary) => runTool({ summary }, { fetch: bitbucket.fetch })),
  )

  // Then
  assert.match(results[0], /2 Absätze, erlaubt 3-4/)
  assert.match(results[1], /5 Absätze, erlaubt 3-4/)
  assert.match(results[2], /Grenze/)
  assert.equal(bitbucket.calls.length, 0)
})

test("Warnungen nennen Pfad und Meldung", async () => {
  // Given
  const bitbucket = fakeBitbucket([pullRequest(7, "feature/SEP-1-x")])

  // When
  const result = await runTool({ summary: SUMMARY.replace("Problem:", "Das grosse Problem ist gross, ß:") }, { fetch: bitbucket.fetch })

  // Then
  assert.match(result, /Description von PR #7 ersetzt/)
  assert.match(result, /\/summary\/1: Eszett gefunden/)
  assert.doesNotMatch(result, /undefined/)
})

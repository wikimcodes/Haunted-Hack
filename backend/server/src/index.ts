// Game API server. Players talk to this over HTTP; live state comes from the Terse WebSocket.
// The server never holds game state itself: GameActor and MonsterActor are the source of truth.

import { fileURLToPath } from "node:url"

import { actors } from "../generated/index.js"
import { archiveGame, leaderboard, startArchiver } from "./archive"
import { monsterReply, witchSpeech } from "./llm"
import { connectAgent, loadRelayConfig, withRelayRetry } from "./relayConfig"
import { MONSTER_IDS, MONSTER_NAMES, isMonsterId, type MonsterId, type RelayMeta } from "./types"

const PORT = Number(process.env.PORT ?? 3001)
const GAME_MS = Number(process.env.GAME_SECONDS ?? 180) * 1000
const REVEAL_MS = Number(process.env.REVEAL_SECONDS ?? 60) * 1000
const MAX_MESSAGE_CHARS = 300
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*"

const relayConfig = await loadRelayConfig()
const RELAY_MODE = relayConfig.baseUrl ? "local" : "hosted"
const { agent: gamemaster } = await connectAgent("gamemaster", relayConfig)

const game = (sessionId: string) => actors.GameActor.get(sessionId)
const monster = (sessionId: string, monsterId: MonsterId) => actors.MonsterActor.get(`${sessionId}.${monsterId}`)

// Duplicate chat requests (double clicks, retries) return the first result.
const chatResults = new Map<string, Promise<unknown>>()

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}

function json(body: unknown, status = 200): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json",
            "access-control-allow-origin": ALLOWED_ORIGIN,
            "access-control-allow-headers": "content-type",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-expose-headers": "x-server-time",
            // Lets clients correct for a phone clock that is off when showing the countdown.
            "x-server-time": String(Date.now())
        }
    })
}

async function body<T>(req: Request): Promise<T> {
    try {
        return (await req.json()) as T
    } catch {
        throw new HttpError(400, "invalid_json")
    }
}

async function requireGame(sessionId: string) {
    const state = await game(sessionId).getPublicState()
    if (!state) throw new HttpError(404, "game_not_found")
    return state
}

// ----- handlers --------------------------------------------------------------

async function startGame(req: Request) {
    const input = await body<{ gameSeconds?: number; revealSeconds?: number }>(req).catch(() => ({}) as { gameSeconds?: number; revealSeconds?: number })
    const sessionId = `game_${crypto.randomUUID().slice(0, 8)}`
    const gameMs = input.gameSeconds ? Math.min(Math.max(input.gameSeconds, 30), 900) * 1000 : GAME_MS
    const revealMs = input.revealSeconds ? Math.min(Math.max(input.revealSeconds, 10), 300) * 1000 : REVEAL_MS
    const state = await game(sessionId).start({ gameMs, revealMs })
    await actors.Lobby.get("main").add(sessionId).catch(err => console.error("[lobby]", String(err)))
    return json(state, 201)
}

async function chat(req: Request, sessionId: string) {
    const input = await body<{ monsterId?: string; message?: string; requestId?: string }>(req)
    if (!isMonsterId(input.monsterId)) throw new HttpError(400, "unknown_monster")
    const text = (input.message ?? "").trim()
    if (!text || text.length > MAX_MESSAGE_CHARS) throw new HttpError(400, "message_length")
    const requestId = input.requestId ?? crypto.randomUUID()
    const key = `${sessionId}:${requestId}`
    if (!chatResults.has(key)) {
        const run = runChat(sessionId, input.monsterId, text, requestId)
        chatResults.set(key, run)
        // Keep a finished reply long enough to answer retries, then forget it.
        run.then(
            () => setTimeout(() => chatResults.delete(key), 60_000),
            () => chatResults.delete(key)
        )
    }
    return json(await chatResults.get(key))
}

async function runChat(sessionId: string, monsterId: MonsterId, text: string, requestId: string) {
    const g = game(sessionId)
    const state = await requireGame(sessionId)
    if (state.phase !== "playing" || Date.now() >= state.deadlineAt) throw new HttpError(409, "game_over")

    const fact = await g.recordPlayerFact(monsterId, text)
    await g.setMonsterMood(monsterId, "thinking")

    const [brief, memory] = await Promise.all([g.briefing(monsterId), monster(sessionId, monsterId).memory()])
    const answer = await monsterReply({
        monsterId,
        isSpy: brief.isSpy,
        playerMessage: text,
        history: memory.history,
        rumours: memory.rumours.map(r => ({ from: MONSTER_NAMES[r.from as MonsterId] ?? r.from, text: r.text })),
        otherNames: MONSTER_IDS.filter(id => id !== monsterId).map(id => MONSTER_NAMES[id])
    })
    await monster(sessionId, monsterId).rememberExchange(text, answer.reply)
    const mood = answer.nervous ? "nervous" : "talking"
    await g.setMonsterMood(monsterId, mood)
    setTimeout(() => void g.settleMood(monsterId, mood).catch(() => {}), 4000)

    // Hand the new fact to that monster's own agent process over Relay.
    const meta: RelayMeta = { kind: "heard", sessionId, factId: fact.id }
    withRelayRetry("heard", () =>
        gamemaster.sendMessage({ to: `@${monsterId}`, text: `The human told you: "${fact.text}"`, metadata: meta, idempotencyKey: `heard-${sessionId}-${requestId}` })
    )
        .then(sent => g.recordHandoff(sent.id))
        .catch(err => console.error("[chat] relay handoff failed:", String(err)))

    return { monsterId, reply: answer.reply, factId: fact.id, source: answer.source }
}

async function accuse(req: Request, sessionId: string) {
    const input = await body<{ monsterId?: string }>(req)
    if (!isMonsterId(input.monsterId)) throw new HttpError(400, "unknown_monster")
    await requireGame(sessionId)
    const state = await game(sessionId).accuse(input.monsterId)
    // Archive straight away so the leaderboard updates the moment the game ends.
    archiveGame(sessionId, RELAY_MODE).catch(err => console.warn("[archive]", sessionId, String(err).slice(0, 160)))
    return json({ outcome: state.phase, state })
}

async function socket(req: Request, sessionId: string) {
    const input = await body<{ role?: string; playerId?: string }>(req).catch(() => ({}) as { role?: string; playerId?: string })
    const state = await requireGame(sessionId)
    const role = input.role === "director" ? "director" : "player"
    if (role === "director" && state.phase === "playing") throw new HttpError(403, "director_after_game_only")
    const grant = await actors.GameActor.prepareWebsocket({
        actorId: sessionId,
        metadata: { playerId: input.playerId ?? crypto.randomUUID(), role }
    })
    return json({ ...grant, websocketUrl: publicSocketUrl(req, grant.websocketUrl) })
}

async function director(sessionId: string) {
    const state = await requireGame(sessionId)
    if (state.phase === "playing") throw new HttpError(403, "director_after_game_only")
    const view = await game(sessionId).director()
    if (!view) throw new HttpError(404, "game_not_found")

    // Re-read every message from Agent Relay so the Director View shows what Relay actually carried.
    const ids = [...view.gossip.map(g => g.relayMessageId), ...view.reports.map(r => r.relayMessageId), ...view.rejectedReports.map(r => r.relayMessageId)].filter(
        (id): id is string => !!id
    )
    const relayMessages = await Promise.all(
        ids.map(async id => {
            try {
                const m = await withRelayRetry("director read", () => gamemaster.messages.get(id))
                return { id, from: m.from?.name ?? null, text: m.text ?? null, createdAt: m.createdAt ?? null, metadata: m.metadata ?? null }
            } catch (err) {
                return { id, error: String(err) }
            }
        })
    )
    return json({ ...view, relay: { workspace: relayConfig.workspaceName, messages: relayMessages } })
}

// The witch speaks each revealed clue aloud. Only clues already in the public state can be voiced,
// so this never leaks anything. Each clue is generated once and cached.
const voiceCache = new Map<string, Promise<ArrayBuffer | null>>()

async function witchVoice(sessionId: string, clueId: string) {
    const state = await requireGame(sessionId)
    const clue = state.clues.find(c => c.id === clueId)
    if (!clue) throw new HttpError(404, "clue_not_revealed")
    const key = `${sessionId}:${clueId}`
    if (!voiceCache.has(key)) {
        const audio = witchSpeech(clue.content)
        voiceCache.set(key, audio)
        audio.then(a => !a && voiceCache.delete(key))
        if (voiceCache.size > 500) voiceCache.delete(voiceCache.keys().next().value!)
    }
    const audio = await voiceCache.get(key)
    if (!audio) throw new HttpError(503, "voice_unavailable")
    return new Response(audio, {
        headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400", "access-control-allow-origin": ALLOWED_ORIGIN }
    })
}

async function recentGames() {
    const recent = await actors.Lobby.get("main").list()
    const games = await Promise.all(
        recent.map(async g => {
            const state = await game(g.sessionId).getPublicState().catch(() => null)
            return state ? { sessionId: g.sessionId, startedAt: g.startedAt, phase: state.phase, deadlineAt: state.deadlineAt } : null
        })
    )
    return json(games.filter(Boolean))
}

// Live Relay feed for the Director screen, read from Relay's durable workspace event log.
// While the game runs, sender and text are hidden so the screen cannot give the spy away.
const RELAY_API = relayConfig.baseUrl
    ? `${relayConfig.baseUrl.replace(/\/$/, "")}/v1`
    : relayConfig.workspaceKey.startsWith("rk_")
      ? "https://cast.agentrelay.com/v1"
      : "https://armadillo.agentrelay.com/v1"

interface RelayLogEvent {
    seq: number
    type: string
    created_at: string
    payload?: { message?: { id?: string; agent_name?: string; text?: string } }
}

async function relayEvents(since?: number): Promise<{ events: RelayLogEvent[]; latestSeq: number }> {
    const query = since === undefined ? "limit=1" : `since=${since}&limit=100`
    const res = await withRelayRetry("event log", async () => {
        const r = await fetch(`${RELAY_API}/workspace/events?${query}`, { headers: { authorization: `Bearer ${relayConfig.workspaceKey}` } })
        if (!r.ok) throw new Error(`relay events ${r.status}`)
        return (await r.json()) as { data: { events: RelayLogEvent[]; latest_seq: number } }
    })
    return { events: res.data.events, latestSeq: res.data.latest_seq }
}

async function relayLive(req: Request, sessionId: string) {
    const state = await requireGame(sessionId)
    const sinceParam = new URL(req.url).searchParams.get("since")
    let since = sinceParam === null ? undefined : Number(sinceParam)
    if (since === undefined || Number.isNaN(since)) {
        // First call: look back far enough to cover this game.
        const { latestSeq } = await relayEvents()
        since = Math.max(0, latestSeq - 100)
    }
    const [{ events, latestSeq }, ownIds] = await Promise.all([relayEvents(since), game(sessionId).relayMessageIds()])
    const mine = new Set(ownIds)
    const playing = state.phase === "playing"
    const from = state.startedAt - 2000
    const recent = Date.now() - 20_000
    const dms = events.filter(e => e.type === "dm.received" && e.payload?.message?.id).map(e => ({ e, at: Date.parse(e.created_at) }))
    // A message is linked to this game only once its sender records it, so the cursor must not move
    // past recent unlinked messages: they may turn out to belong to this game a moment later.
    const pending = dms.filter(({ e, at }) => !mine.has(e.payload!.message!.id!) && at >= recent)
    const nextSince = pending.length ? Math.min(...pending.map(({ e }) => e.seq)) - 1 : Math.max(latestSeq, since)
    const rows = dms
        .filter(({ e, at }) => at >= from && mine.has(e.payload!.message!.id!))
        .map(({ e, at }) => {
            const m = e.payload!.message!
            const sender = m.agent_name ?? "?"
            const kind = sender === "gamemaster" ? "handoff" : "whisper"
            return {
                seq: e.seq,
                relayMessageId: m.id!,
                at,
                kind,
                from: playing && kind === "whisper" ? null : sender,
                text: playing ? null : (m.text ?? null),
                length: (m.text ?? "").length
            }
        })
    return json({ phase: state.phase, nextSince, events: rows })
}

// ----- local Terse socket relay ------------------------------------------------
// The local Terse runtime only listens on 127.0.0.1, so phones on the same wifi cannot reach it.
// When actors run locally, socket grants point at /terse-ws on this server, which pipes the
// connection to the local runtime. Only the Terse socket path is ever forwarded.
// With deployed actors (TERSE_ACTOR_URL set) grants are already public and pass through untouched.

const LOCAL_TERSE = "127.0.0.1:7100"

function publicSocketUrl(req: Request, websocketUrl: string): string {
    const upstream = new URL(websocketUrl)
    if (!["127.0.0.1", "localhost"].includes(upstream.hostname)) return websocketUrl
    const requestUrl = new URL(req.url)
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? requestUrl.host
    if (/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) return websocketUrl
    const secure = (req.headers.get("x-forwarded-proto") ?? requestUrl.protocol.replace(":", "")) === "https"
    return `${secure ? "wss" : "ws"}://${host}/terse-ws?to=${encodeURIComponent(upstream.pathname + upstream.search)}`
}

type RelaySocketData = { to: string; upstream?: WebSocket; queue: (string | Buffer)[] }

const DIRECTOR_PAGE = fileURLToPath(new URL("../public/director.html", import.meta.url))

// ----- router ----------------------------------------------------------------

const routes: [string, RegExp, (req: Request, m: RegExpMatchArray) => Promise<Response>][] = [
    ["GET", /^\/health$/, async () => json({ ok: true, relayWorkspace: relayConfig.workspaceName, relay: relayConfig.baseUrl ? "local" : "hosted" })],
    ["GET", /^\/director\/?$/, async () => new Response(Bun.file(DIRECTOR_PAGE), { headers: { "content-type": "text/html; charset=utf-8" } })],
    ["GET", /^\/api\/games\/recent$/, () => recentGames()],
    ["GET", /^\/api\/leaderboard$/, async () => json((await leaderboard()) ?? { disabled: true })],
    ["POST", /^\/api\/game\/start$/, req => startGame(req)],
    ["GET", /^\/api\/game\/([\w-]+)$/, async (_req, m) => json(await requireGame(m[1]!))],
    ["POST", /^\/api\/game\/([\w-]+)\/chat$/, (req, m) => chat(req, m[1]!)],
    ["POST", /^\/api\/game\/([\w-]+)\/accuse$/, (req, m) => accuse(req, m[1]!)],
    ["POST", /^\/api\/game\/([\w-]+)\/socket$/, (req, m) => socket(req, m[1]!)],
    ["GET", /^\/api\/game\/([\w-]+)\/director$/, (_req, m) => director(m[1]!)],
    ["GET", /^\/api\/game\/([\w-]+)\/relay-live$/, (req, m) => relayLive(req, m[1]!)],
    ["GET", /^\/api\/game\/([\w-]+)\/voice\/([\w-]+)$/, (_req, m) => witchVoice(m[1]!, m[2]!)]
]

Bun.serve<RelaySocketData>({
    port: PORT,
    idleTimeout: 30,
    websocket: {
        open(ws) {
            const upstream = new WebSocket(`ws://${LOCAL_TERSE}${ws.data.to}`)
            ws.data.upstream = upstream
            upstream.onopen = () => ws.data.queue.splice(0).forEach(m => upstream.send(m))
            upstream.onmessage = event => ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer))
            upstream.onclose = event => ws.close(event.code >= 3000 || event.code === 1000 ? event.code : 1011, event.reason)
            upstream.onerror = () => ws.close(1011, "upstream_error")
        },
        message(ws, message) {
            const upstream = ws.data.upstream
            if (upstream?.readyState === WebSocket.OPEN) upstream.send(message)
            else ws.data.queue.push(message)
        },
        close(ws) {
            ws.data.upstream?.close()
        }
    },
    async fetch(req, server) {
        if (req.method === "OPTIONS") return json(null, 204)
        const { pathname, searchParams } = new URL(req.url)
        if (pathname === "/terse-ws") {
            const to = searchParams.get("to") ?? ""
            if (!/^\/v1\/socket\?key=[\w.-]+$/.test(to)) return json({ error: "bad_socket_target" }, 400)
            return server.upgrade(req, { data: { to, queue: [] } }) ? undefined : json({ error: "upgrade_failed" }, 400)
        }
        for (const [method, pattern, handler] of routes) {
            const match = pathname.match(pattern)
            if (match && req.method === method) {
                try {
                    return await handler(req, match)
                } catch (err) {
                    if (err instanceof HttpError) return json({ error: err.message }, err.status)
                    const message = String((err as Error)?.message ?? err)
                    const known = message.match(/game_over|game_not_started|unknown_monster|too_many_messages/)
                    if (known) return json({ error: known[0] }, 409)
                    console.error(`[${method} ${pathname}]`, err)
                    return json({ error: "internal_error" }, 500)
                }
            }
        }
        return json({ error: "not_found" }, 404)
    }
})

console.log(`Spy Monster server on http://localhost:${PORT} (${relayConfig.baseUrl ? "local" : "hosted"} Relay workspace ${relayConfig.workspaceName})`)
startArchiver(RELAY_MODE)

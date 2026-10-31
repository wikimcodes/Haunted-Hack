// Game API server. Players talk to this over HTTP; live state comes from the Terse WebSocket.
// The server never holds game state itself: GameActor and MonsterActor are the source of truth.

import { fileURLToPath } from "node:url"

import { actors } from "../generated/index.js"
import { monsterReply } from "./llm"
import { connectAgent, loadRelayConfig, withRelayRetry } from "./relayConfig"
import { MONSTER_IDS, MONSTER_NAMES, isMonsterId, type MonsterId, type RelayMeta } from "./types"

const PORT = Number(process.env.PORT ?? 3001)
const GAME_MS = Number(process.env.GAME_SECONDS ?? 180) * 1000
const REVEAL_MS = Number(process.env.REVEAL_SECONDS ?? 60) * 1000
const MAX_MESSAGE_CHARS = 300
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*"

const relayConfig = await loadRelayConfig()
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
            "access-control-allow-methods": "GET,POST,OPTIONS"
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
        run.catch(() => chatResults.delete(key))
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
    await g.setMonsterMood(monsterId, answer.nervous ? "nervous" : "talking")
    setTimeout(() => void g.setMonsterMood(monsterId, "idle").catch(() => {}), 4000)

    // Hand the new fact to that monster's own agent process over Relay.
    const meta: RelayMeta = { kind: "heard", sessionId, factId: fact.id }
    withRelayRetry("heard", () =>
        gamemaster.sendMessage({ to: `@${monsterId}`, text: `The human told you: "${fact.text}"`, metadata: meta, idempotencyKey: `heard-${sessionId}-${requestId}` })
    ).catch(err => console.error("[chat] relay handoff failed:", String(err)))

    return { monsterId, reply: answer.reply, factId: fact.id, source: answer.source }
}

async function accuse(req: Request, sessionId: string) {
    const input = await body<{ monsterId?: string }>(req)
    if (!isMonsterId(input.monsterId)) throw new HttpError(400, "unknown_monster")
    await requireGame(sessionId)
    const state = await game(sessionId).accuse(input.monsterId)
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
    return json(grant)
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

const DIRECTOR_PAGE = fileURLToPath(new URL("../public/director.html", import.meta.url))

// ----- router ----------------------------------------------------------------

const routes: [string, RegExp, (req: Request, m: RegExpMatchArray) => Promise<Response>][] = [
    ["GET", /^\/health$/, async () => json({ ok: true, relayWorkspace: relayConfig.workspaceName })],
    ["GET", /^\/director\/?$/, async () => new Response(Bun.file(DIRECTOR_PAGE), { headers: { "content-type": "text/html; charset=utf-8" } })],
    ["GET", /^\/api\/games\/recent$/, () => recentGames()],
    ["POST", /^\/api\/game\/start$/, req => startGame(req)],
    ["GET", /^\/api\/game\/([\w-]+)$/, async (_req, m) => json(await requireGame(m[1]!))],
    ["POST", /^\/api\/game\/([\w-]+)\/chat$/, (req, m) => chat(req, m[1]!)],
    ["POST", /^\/api\/game\/([\w-]+)\/accuse$/, (req, m) => accuse(req, m[1]!)],
    ["POST", /^\/api\/game\/([\w-]+)\/socket$/, (req, m) => socket(req, m[1]!)],
    ["GET", /^\/api\/game\/([\w-]+)\/director$/, (_req, m) => director(m[1]!)]
]

Bun.serve({
    port: PORT,
    idleTimeout: 30,
    async fetch(req) {
        if (req.method === "OPTIONS") return json(null, 204)
        const { pathname } = new URL(req.url)
        for (const [method, pattern, handler] of routes) {
            const match = pathname.match(pattern)
            if (match && req.method === method) {
                try {
                    return await handler(req, match)
                } catch (err) {
                    if (err instanceof HttpError) return json({ error: err.message }, err.status)
                    const message = String((err as Error)?.message ?? err)
                    if (/game_over|game_not_started|unknown_monster/.test(message)) return json({ error: message.match(/game_over|game_not_started|unknown_monster/)![0] }, 409)
                    console.error(`[${method} ${pathname}]`, err)
                    return json({ error: "internal_error" }, 500)
                }
            }
        }
        return json({ error: "not_found" }, 404)
    }
})

console.log(`Spy Monster server on http://localhost:${PORT} (Relay workspace ${relayConfig.workspaceName})`)

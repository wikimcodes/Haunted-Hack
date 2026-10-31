// Cross-game archive in Supabase Postgres (schema: backend/supabase/schema.sql).
// Terse actors own each live game; when a game ends, one summary row lands here so
// leaderboard questions never have to wake every game actor.
// Optional: without SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY the game runs unchanged.

import { actors } from "../generated/index.js"

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, "")
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
export const archiveEnabled = !!SUPABASE_URL && !!SERVICE_KEY

const archived = new Set<string>()

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...init,
        headers: { apikey: SERVICE_KEY!, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json", ...init.headers }
    })
    if (!res.ok) throw new Error(`supabase ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return res
}

/** Writes one finished game. Idempotent (upsert on session_id), so retries and repeats are safe. */
export async function archiveGame(sessionId: string, relayMode: "hosted" | "local"): Promise<boolean> {
    if (!archiveEnabled || archived.has(sessionId)) return false
    const view = await actors.GameActor.get(sessionId).director()
    if (!view || view.public.phase === "playing") return false
    const pub = view.public
    const endedAt = pub.clues.find(c => c.kind === "ending")?.revealedAt ?? pub.accusation?.at ?? pub.deadlineAt
    const row = {
        session_id: sessionId,
        started_at: new Date(pub.startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        outcome: pub.phase,
        spy: view.spyId,
        accused: pub.accusation?.monsterId ?? null,
        duration_seconds: Math.max(0, Math.round((endedAt - pub.startedAt) / 1000)),
        player_messages: view.facts.length,
        whispers: view.gossip.filter(g => g.relayMessageId).length,
        spy_reports: view.reports.length,
        fake_reports_blocked: view.rejectedReports.filter(r => (r.reason ?? "not_spy") === "not_spy").length,
        clues_revealed: pub.clues.filter(c => c.kind !== "ending").length,
        relay_mode: relayMode
    }
    await rest("games?on_conflict=session_id", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) })
    archived.add(sessionId)
    return true
}

/** Sweeps recent games every 10s so games that end at dawn (on the actor alarm) are archived too. */
export function startArchiver(relayMode: "hosted" | "local"): void {
    if (!archiveEnabled) {
        console.log("[archive] Supabase not configured, leaderboard off")
        return
    }
    const sweep = async () => {
        try {
            const recent = await actors.Lobby.get("main").list()
            for (const g of recent) {
                if (archived.has(g.sessionId)) continue
                await archiveGame(g.sessionId, relayMode).catch(err => console.warn("[archive]", g.sessionId, String(err).slice(0, 160)))
            }
        } catch (err) {
            console.warn("[archive] sweep failed:", String(err).slice(0, 160))
        }
    }
    void sweep()
    setInterval(sweep, 10_000)
    console.log("[archive] archiving finished games to Supabase")
}

export interface Leaderboard {
    totals: {
        games: number
        players_escaped: number
        escape_rate_pct: number | null
        fastest_catch_seconds: number | null
        total_whispers: number
        total_fakes_blocked: number
    } | null
    monsters: { monster: string; times_spy: number; times_got_away: number; got_away_pct: number | null }[]
    recent: { session_id: string; outcome: string; spy: string; accused: string | null; duration_seconds: number; ended_at: string }[]
}

export async function leaderboard(): Promise<Leaderboard | null> {
    if (!archiveEnabled) return null
    const [totals, monsters, recent] = await Promise.all([
        rest("game_totals?select=*").then(r => r.json() as Promise<Leaderboard["totals"][]>),
        rest("monster_stats?select=*&order=got_away_pct.desc.nullslast").then(r => r.json() as Promise<Leaderboard["monsters"]>),
        rest("games?select=session_id,outcome,spy,accused,duration_seconds,ended_at&order=ended_at.desc&limit=8").then(r => r.json() as Promise<Leaderboard["recent"]>)
    ])
    return { totals: totals[0] ?? null, monsters, recent }
}

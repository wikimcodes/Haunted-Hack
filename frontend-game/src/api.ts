// Plain fetch client for the game server. No React, so it can be used anywhere.

import type { ChatResult, MonsterId, PublicGameState } from "./types"

export class GameApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string
    ) {
        super(code)
    }
}

export function createGameApi(
    baseUrl: string,
    options: { timeoutMs?: number; chatTimeoutMs?: number; onServerTime?: (offsetMs: number) => void } = {}
) {
    const base = baseUrl.replace(/\/$/, "")

    async function request<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = options.timeoutMs ?? 15_000): Promise<T> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
            const res = await fetch(base + path, {
                method,
                headers: body === undefined ? undefined : { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            })
            // Server clock minus this device's clock. The server stamps the time as it sends the response,
            // so compare with when it arrived (network delay is small next to a wrong phone clock).
            const serverTime = Number(res.headers.get("x-server-time"))
            if (options.onServerTime && serverTime > 0) options.onServerTime(serverTime - Date.now())
            const data = await res.json().catch(() => null)
            if (!res.ok) throw new GameApiError(res.status, (data as { error?: string } | null)?.error ?? "request_failed")
            if (data === null) throw new GameApiError(502, "invalid_response")
            return data as T
        } catch (error) {
            if (controller.signal.aborted) throw new GameApiError(408, "request_timeout")
            throw error
        } finally {
            clearTimeout(timer)
        }
    }

    const gamePath = (sessionId: string) => `/api/game/${encodeURIComponent(sessionId)}`

    return {
        start: (options: { gameSeconds?: number; revealSeconds?: number } = {}) => request<PublicGameState>("POST", "/api/game/start", options),
        get: (sessionId: string) => request<PublicGameState>("GET", gamePath(sessionId)),
        chat: (sessionId: string, monsterId: MonsterId, message: string, requestId = crypto.randomUUID()) =>
            request<ChatResult>("POST", `${gamePath(sessionId)}/chat`, { monsterId, message, requestId }, options.chatTimeoutMs ?? 45_000),
        accuse: (sessionId: string, monsterId: MonsterId) =>
            request<{ outcome: PublicGameState["phase"]; state: PublicGameState }>("POST", `${gamePath(sessionId)}/accuse`, { monsterId }),
        socket: (sessionId: string, role: "player" | "director" = "player") =>
            request<{ websocketUrl: string }>("POST", `${gamePath(sessionId)}/socket`, { role }),
        director: (sessionId: string) => request<unknown>("GET", `${gamePath(sessionId)}/director`),
        /** MP3 of the witch speaking a revealed clue (OpenAI text-to-speech). */
        voiceUrl: (sessionId: string, clueId: string) => `${base}${gamePath(sessionId)}/voice/${encodeURIComponent(clueId)}`
    }
}

export type GameApi = ReturnType<typeof createGameApi>

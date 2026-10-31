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

export function createGameApi(baseUrl: string) {
    const base = baseUrl.replace(/\/$/, "")

    async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
        const res = await fetch(base + path, {
            method,
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body)
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new GameApiError(res.status, (data as { error?: string }).error ?? "request_failed")
        return data as T
    }

    return {
        start: (options: { gameSeconds?: number; revealSeconds?: number } = {}) => request<PublicGameState>("POST", "/api/game/start", options),
        get: (sessionId: string) => request<PublicGameState>("GET", `/api/game/${sessionId}`),
        chat: (sessionId: string, monsterId: MonsterId, message: string, requestId = crypto.randomUUID()) =>
            request<ChatResult>("POST", `/api/game/${sessionId}/chat`, { monsterId, message, requestId }),
        accuse: (sessionId: string, monsterId: MonsterId) =>
            request<{ outcome: PublicGameState["phase"]; state: PublicGameState }>("POST", `/api/game/${sessionId}/accuse`, { monsterId }),
        socket: (sessionId: string, role: "player" | "director" = "player") =>
            request<{ websocketUrl: string }>("POST", `/api/game/${sessionId}/socket`, { role }),
        director: (sessionId: string) => request<unknown>("GET", `/api/game/${sessionId}/director`)
    }
}

export type GameApi = ReturnType<typeof createGameApi>

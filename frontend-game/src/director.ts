const DEFAULT_API_URL = "http://localhost:3001"

/** Keep Director on the same API origin and path prefix as the game client. */
export function directorUrl(apiUrl?: string, sessionId?: string | null, documentOrigin?: string): string | null {
    try {
        const url = new URL(apiUrl?.trim() || DEFAULT_API_URL, documentOrigin)
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null
        url.pathname = url.pathname.replace(/\/+$/, "") + "/director"
        url.search = ""
        url.hash = ""
        if (sessionId?.trim()) url.searchParams.set("game", sessionId)
        return url.toString()
    } catch { return null }
}

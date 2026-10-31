import type { MouseEventHandler, ReactNode } from "react"
import { directorUrl } from "../director"

export interface DirectorLinkProps {
    apiUrl?: string
    sessionId?: string | null
    className?: string
    children?: ReactNode
    /** Match the visible wording when a custom label is supplied. */
    label?: string
    onClick?: MouseEventHandler<HTMLAnchorElement>
}

export function DirectorLink({ apiUrl, sessionId, className, children, label = "Director View", onClick }: DirectorLinkProps) {
    const href = directorUrl(apiUrl, sessionId, typeof window === "undefined" ? undefined : window.location.origin)
    if (!href) return <span className={className} aria-disabled="true" title="Director View is unavailable: check the game API address.">{children ?? "Director View"}</span>
    return <a href={href} target="_blank" rel="noopener noreferrer" className={className}
        aria-label={`${label} (opens in a new tab)`} title="Opens Director View in a new tab" onClick={onClick}>
        {children ?? <>Director View <span aria-hidden="true">↗</span></>}
    </a>
}

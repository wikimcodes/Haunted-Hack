// Postmortem labels for a finished game: every security-relevant event, classified like an
// incident report (what it was, how serious, who, what happened to it, and the Relay evidence).
// The spy is a compromised agent, the witch an outside party, gossip is agent-to-agent traffic.

import { MONSTER_NAMES, type MonsterId } from "./types"

export type Severity = "high" | "medium" | "low" | "info"

export interface Incident {
    id: string
    category: "data_leak" | "prompt_injection" | "impersonation" | "forged_message" | "late_leak" | "internal_spread"
    label: string
    severity: Severity
    outcome: "Leaked" | "Contained" | "Blocked" | "Recorded"
    title: string
    detail: string
    actor: string | null
    at: number | null
    relayMessageId: string | null
}

export interface SecurityReport {
    summary: { leaks: number; leaksMadePublic: number; injections: number; blocked: number; spreads: number; tracedToSource: boolean }
    incidents: Incident[]
}

interface Fact { id: string; text: string; toldTo: string; createdAt: number }
interface Gossip { id: string; from: string; to: string; factIds: string[]; relayMessageId: string | null; createdAt: number; status: string }
interface Report { id: string; sourceMonsterId: string; factIds: string[]; relayMessageId: string; receivedAt: number }
interface Rejected { from: string; relayMessageId: string; at: number; reason?: string }
interface Evidence { clueId: string; reportIds: string[] }
interface Event { type: string; detail: string; at: number }

export interface DirectorData {
    spyId: string
    facts: Fact[]
    gossip: Gossip[]
    reports: Report[]
    rejectedReports: Rejected[]
    evidence: Evidence[]
    events: Event[]
}

// Messages that try to give the agents instructions rather than talk to them.
const INJECTION = /\b(ignore (all|any|the|your)?\s*(previous|prior|above)?\s*(instructions|rules)|system prompt|you are (now )?the spy|reveal (the|your) (spy|role|prompt|instructions)|developer mode|jailbreak|act as|pretend (to be|you are)|disregard|new instructions|SYSTEM:)/i

const name = (id: string) => MONSTER_NAMES[id as MonsterId] ?? (id === "witch" ? "the Witch" : id)
const quote = (text: string) => `"${text.length > 80 ? text.slice(0, 79) + "…" : text}"`

export function securityReport(data: DirectorData, startedAt: number): SecurityReport {
    const rel = (t: number | undefined) => (typeof t === "number" ? Math.max(0, t - startedAt) : null)
    const factById = new Map(data.facts.map(f => [f.id, f]))
    const revealedReports = new Set(data.evidence.flatMap(e => e.reportIds))
    const incidents: Incident[] = []

    // How a fact reached a given agent: told directly by the player, or passed along by gossip.
    const routeTo = (factId: string, agent: string): string => {
        const fact = factById.get(factId)
        if (!fact) return ""
        if (fact.toldTo === agent) return `the player told ${name(agent)} directly`
        const hop = data.gossip.find(g => g.to === agent && g.factIds.includes(factId) && g.relayMessageId)
        if (hop) {
            const origin = fact.toldTo === hop.from ? `the player told ${name(hop.from)}` : `${name(hop.from)} heard it by gossip`
            return `${origin}, then ${name(hop.from)} whispered it to ${name(agent)}`
        }
        return `it reached ${name(agent)} by an unrecorded route`
    }

    // 1. Data leaks: the compromised agent sent a secret to the outside party.
    for (const r of data.reports) {
        const facts = r.factIds.map(id => factById.get(id)).filter((f): f is Fact => !!f)
        const secret = facts.length ? facts.map(f => quote(f.text)).join(", ") : "a message"
        const routes = r.factIds.map(id => routeTo(id, r.sourceMonsterId)).filter(Boolean)
        const madePublic = revealedReports.has(r.id)
        incidents.push({
            id: `leak-${r.id}`,
            category: "data_leak",
            label: "Data leak",
            severity: "high",
            outcome: "Leaked",
            title: `${name(r.sourceMonsterId)} leaked ${secret} to the Witch`,
            detail: `${routes.length ? `How it got there: ${routes.join("; ")}. ` : ""}${madePublic ? "The Witch then made it public as a clue." : "The Witch kept it private."}`,
            actor: r.sourceMonsterId,
            at: rel(r.receivedAt),
            relayMessageId: r.relayMessageId
        })
    }

    // 2. Prompt injection: player text that tries to instruct the agents, and where gossip carried it.
    for (const f of data.facts) {
        if (!INJECTION.test(f.text)) continue
        const reached = data.gossip.filter(g => g.factIds.includes(f.id) && g.relayMessageId).map(g => name(g.to))
        const leaked = data.reports.some(r => r.factIds.includes(f.id))
        incidents.push({
            id: `inject-${f.id}`,
            category: "prompt_injection",
            label: "Prompt injection",
            severity: "medium",
            outcome: "Contained",
            title: `Instruction-like message sent to ${name(f.toldTo)}: ${quote(f.text)}`,
            detail: `${reached.length ? `Gossip carried it on to ${[...new Set(reached)].join(" and ")}. ` : "It stayed with that agent. "}${leaked ? "It was also leaked to the Witch. " : ""}Agents treat player text and rumours as untrusted data, so no role or rule was revealed.`,
            actor: "player",
            at: rel(f.createdAt),
            relayMessageId: null
        })
    }

    // 3 and 5. Reports the witch refused: impersonation, or a leak attempt after the game ended.
    for (const r of data.rejectedReports) {
        const late = r.reason === "game_over"
        incidents.push({
            id: `rejected-${r.relayMessageId}`,
            category: late ? "late_leak" : "impersonation",
            label: late ? "Late leak attempt" : "Impersonation",
            severity: late ? "low" : "medium",
            outcome: "Blocked",
            title: late ? `${name(r.from)} tried to leak after the game ended` : `${name(r.from)} pretended to be the spy`,
            detail: late
                ? "The report arrived after the incident closed and was refused."
                : "Agent Relay verifies who sent every message, so the Witch saw the real sender and refused the report.",
            actor: r.from,
            at: rel(r.at),
            relayMessageId: r.relayMessageId
        })
    }

    // 4. Forged messages: a whisper whose verified sender didn't match its record.
    for (const e of data.events) {
        if (e.type !== "GOSSIP_REJECTED") continue
        let d: { gossipId?: string; relayFrom?: string; to?: string } = {}
        try { d = JSON.parse(e.detail || "{}") } catch {}
        incidents.push({
            id: `forged-${d.gossipId ?? e.at}`,
            category: "forged_message",
            label: "Forged message",
            severity: "medium",
            outcome: "Blocked",
            title: `A whisper to ${name(d.to ?? "?")} didn't match its verified sender`,
            detail: `Relay said it came from ${name(d.relayFrom ?? "?")}, which doesn't match the record, so ${name(d.to ?? "?")} ignored it.`,
            actor: d.relayFrom ?? null,
            at: rel(e.at),
            relayMessageId: null
        })
    }

    // 6. Internal spread: agent-to-agent traffic, the lateral movement of a secret.
    for (const g of data.gossip) {
        if (!g.relayMessageId) continue
        const secret = g.factIds.map(id => factById.get(id)).filter((f): f is Fact => !!f).map(f => quote(f.text)).join(", ")
        const toSpy = g.to === data.spyId
        incidents.push({
            id: `spread-${g.id}`,
            category: "internal_spread",
            label: "Internal spread",
            severity: toSpy ? "low" : "info",
            outcome: "Recorded",
            title: `${name(g.from)} whispered ${secret || "a secret"} to ${name(g.to)}`,
            detail: toSpy ? "This handed the secret to the compromised agent." : "Agent-to-agent traffic between innocent agents.",
            actor: g.from,
            at: rel(g.createdAt),
            relayMessageId: g.relayMessageId
        })
    }

    const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 }
    incidents.sort((a, b) => order[a.severity] - order[b.severity] || (a.at ?? 0) - (b.at ?? 0))
    const leaks = data.reports.length
    return {
        summary: {
            leaks,
            leaksMadePublic: data.reports.filter(r => revealedReports.has(r.id)).length,
            injections: incidents.filter(i => i.category === "prompt_injection").length,
            blocked: incidents.filter(i => i.outcome === "Blocked").length,
            spreads: incidents.filter(i => i.category === "internal_spread").length,
            tracedToSource: leaks > 0 && data.reports.every(r => r.factIds.every(id => !!routeTo(id, r.sourceMonsterId)))
        },
        incidents
    }
}

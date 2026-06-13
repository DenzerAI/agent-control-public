// Agent- und Engine-Konfig — eine Agent-Identitaet (Name aus config/agents.json),
// zwei Engines (Codex, Claude Code).
// Die Engine wird pro Conversation gewaehlt und im Chat-Header getoggelt.

import { useSyncExternalStore } from 'react'

export type Engine = 'codex' | 'claude'

export interface AgentConfig {
  id: string
  name: string
  color: string
  model?: string
  sub?: boolean
  hidden?: boolean
}

// Legacy-Agents (Eva, Wolf, Alex) bleiben hidden — nicht in UI
const HIDDEN_AGENTS = new Set(['eva', 'wolf', 'alex', 'claude'])

let _agents: AgentConfig[] = []
let _agentMap: Record<string, AgentConfig> = {}

const FALLBACK: AgentConfig[] = [
  { id: 'main', name: 'Agent', color: '#e85d5d' },
]

// ── Laufzeit-Anzeigename ────────────────────────────────────────────────────
// Der sichtbare Name des Haupt-Agenten kommt aus config/agents.json (Backend
// /api/agents). Der Code verdrahtet ihn nirgends hart: UI-Strings ziehen ihn
// ueber mainAgentName() / useMainAgentName(). Default ist der FALLBACK-Wert,
// also "Agent" fuer Christians Instanz. Public-Builds setzen hier den im Setup
// vergebenen Namen (Default-Platzhalter "Agent").
const _nameSubs = new Set<() => void>()

// ── Inhaber-Name ────────────────────────────────────────────────────────────
// Der Mensch hinter dem Agenten. Kommt aus config/agents.json (Backend
// /api/agents -> owner). Begruessungen ziehen den Vornamen hierueber, statt
// einen Namen fest zu verdrahten. Leer, bis /api/agents geladen ist.
let _ownerFirstName = ''

/** Aktueller Anzeigename des Haupt-Agenten ('main'). */
export function mainAgentName(): string {
  const main = (_agents.length > 0 ? _agents : FALLBACK).find(a => a.id === 'main')
  return main?.name || FALLBACK[0].name
}

/** Vorname des Inhabers aus config/agents.json, oder '' falls nicht gesetzt. */
export function ownerFirstName(): string {
  return _ownerFirstName
}

/** Auf Aenderungen von Agent- oder Inhaber-Namen hoeren (fuer React-Hook). */
export function subscribeAgents(cb: () => void): () => void {
  _nameSubs.add(cb)
  return () => { _nameSubs.delete(cb) }
}

/** React-Hook: liefert den aktuellen Anzeigenamen des Haupt-Agenten reaktiv. */
export function useMainAgentName(): string {
  return useSyncExternalStore(subscribeAgents, mainAgentName, mainAgentName)
}

/** React-Hook: liefert den Vornamen des Inhabers reaktiv (oder '' falls leer). */
export function useOwnerFirstName(): string {
  return useSyncExternalStore(subscribeAgents, ownerFirstName, ownerFirstName)
}

export async function loadAgents(): Promise<AgentConfig[]> {
  try {
    const res = await fetch('/api/agents')
    const data = await res.json()
    // owner ist kein Agent-Eintrag, sondern der Inhaber-Block — getrennt halten.
    const owner = (data && typeof data === 'object') ? data.owner : null
    _ownerFirstName = (owner && (owner.first_name || owner.name)) ? String(owner.first_name || owner.name) : ''
    _agents = Object.entries(data)
      .filter(([id]) => id !== 'owner')
      .map(([id, a]: [string, any]) => ({
        id,
        name: a.name,
        color: a.color,
        model: a.model || undefined,
        sub: id !== 'main',
        hidden: HIDDEN_AGENTS.has(id),
      }))
  } catch {
    _agents = FALLBACK
  }
  _agentMap = Object.fromEntries(_agents.map(a => [a.id, a]))
  _nameSubs.forEach(cb => { try { cb() } catch { /* ignore */ } })
  return _agents
}

export function getAgents(): AgentConfig[] {
  const all = _agents.length > 0 ? _agents : FALLBACK
  return all.filter(a => !a.hidden)
}

export function getAllAgentsIncludingHidden(): AgentConfig[] {
  return _agents.length > 0 ? _agents : FALLBACK
}

export function getAgent(id: string): AgentConfig | undefined {
  return _agentMap[id] || getAgents().find(a => a.id === id)
}

export function getAgentName(id: string): string {
  // Alte Chats mit agent='claude' werden weiterhin dem Haupt-Agenten zugeordnet
  if (id === 'claude' || id.startsWith('claude-')) return mainAgentName()
  return getAgent(id)?.name || id
}

export function getAgentNames(): Record<string, string> {
  return Object.fromEntries(getAgents().map(a => [a.id, a.name]))
}

export function getAllAgentIds(): string[] {
  return getAgents().map(a => a.id)
}

export function getSubAgentIds(): Set<string> {
  return new Set(getAgents().filter(a => a.sub).map(a => a.id))
}

/** Label fuer eine Engine (Codex CLI oder Claude Code CLI). */
export function getEngineLabel(engine: Engine): string {
  return engine === 'claude' ? 'Claude Code' : 'Codex'
}

/** Kurz-Label fuer kompakte UI. */
export function getEngineShortLabel(engine: Engine): string {
  return engine === 'claude' ? 'Claude' : 'Codex'
}

/** Persistierter Engine-Default fuer neue Chats. */
export function getDefaultEngine(): Engine {
  try {
    return localStorage.getItem('control:engine:default') === 'codex' ? 'codex' : 'claude'
  } catch {
    return 'claude'
  }
}

/** Map any agent author to the unified display name of the main agent. */
export function getUnifiedAuthor(author: string): string {
  const agentNames = new Set(getAllAgentsIncludingHidden().map(a => a.name))
  if (agentNames.has(author) || author === 'Claude Code' || author === 'Agent' || author === 'Tony') return mainAgentName()
  return author
}

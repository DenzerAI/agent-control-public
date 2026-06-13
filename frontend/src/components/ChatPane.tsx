import { useState, useEffect, useRef, useCallback, useMemo, Fragment, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, Hammer, X, ChevronUp, ChevronDown as ChevronDownIcon, Plus, Search, Eye, Pencil, Archive, ArchiveRestore, Square, FileText, Paperclip, ClipboardPaste, Play, Pause, Check, Globe, Bot, ListChecks, type LucideIcon } from 'lucide-react'
import { getAllAgentsIncludingHidden, getDefaultEngine, useOwnerFirstName, type Engine } from '../agents'
import { Chat, markTypewriterRead, buildTallyItems, fmtDur } from './Chat'
import { Composer, type Attachment } from './Composer'
import * as audioQueue from '../audioQueue'
import { playUISound } from '../uiSounds'
import { fuzzyIncludes } from '../fuzzy'
import { useConversationSearch } from '../conversationSearch'
import { acquireWsHub, type WsHubHandle } from '../lib/wsHub'

const COMPOSER_FILE_ACCEPT = 'image/*,audio/*,.m4a,.mp3,.ogg,.wav,.flac,.aac,.webm,.txt,.md,.json,.csv,.pdf,.xlsx,.xlsm,.xls,.docx,.doc,.py,.js,.ts,.html,.css'

interface QueueItem {
  id: string
  text: string
  attachments?: Attachment[]
  ts: number
  clientMessageId?: string
}

type WerkbankFooterTask = {
  id: string
  title?: string
  status?: string
  created_at?: number
  updated_at?: number
  origin?: { conversation_id?: string }
  metrics?: {
    elapsed_ms?: number
    input_tokens?: number
    output_tokens?: number
    changed_lines?: { added?: number; removed?: number }
  }
}

type WerkbankFooterStatus = {
  label: string
  title: string
  tone: 'active' | 'needs-input' | 'done'
  taskId?: string
}

interface PendingVisualDone {
  messageKey: string
  token: number
  didWork: boolean
  status: string
  conversationId?: string
  responseText: string
}

// Begruessungen werden mit dem Inhaber-Vornamen aus config/agents.json gebaut.
// Ohne gesetzten Namen bleiben die neutralen Varianten ohne Anrede.
function buildGreetings(firstName: string): string[] {
  const named = firstName.trim()
  const withName = (greeting: string) => named ? greeting.replace('{name}', named) : ''
  return [
    withName('Hey {name}, wie kann ich dir helfen?'),
    'Hey, was machen wir jetzt?',
    'Hey, was gibt es Neues?',
    'Wobei kann ich dir helfen?',
    'Hey, woran arbeiten wir?',
    withName('Hey {name}, was steht an?'),
    'Worauf hast du Lust?',
    'Was können wir jetzt angehen?',
  ].filter(Boolean)
}

function defaultModelForEngine(next: Engine): string {
  return next === 'codex' ? 'gpt-5.5' : 'claude-opus-4-8'
}

function normalizeModelForEngine(next: Engine, raw?: string): string {
  const value = (raw || '').trim()
  if (next === 'codex') return value.startsWith('gpt-') ? value.toLowerCase() : 'gpt-5.5'
  if (!value || value.startsWith('gpt-')) return 'claude-opus-4-8'
  if (value === 'Opus 4.7') return 'claude-opus-4-7'
  if (value === 'Opus 4.8') return 'claude-opus-4-8'
  return value
}

function EmptyGreeting() {
  const ownerFirst = useOwnerFirstName()
  // Index einmal fest waehlen, Anzeige folgt dem (evtl. spaeter geladenen) Namen.
  const [idx] = useState(() => Math.floor(Math.random() * 8))
  const greetings = buildGreetings(ownerFirst)
  const greeting = greetings[idx % greetings.length] || greetings[0]
  return (
    <div className="h-full w-full flex flex-col items-center justify-center px-6 animate-[fadeIn_0.6s_ease]">
      <div
        className="text-center text-[var(--t1)] font-semibold leading-tight text-[30px] sm:text-[36px] md:text-[42px]"
        style={{ fontFamily: 'var(--font-heading)' }}
      >
        {greeting}
      </div>
    </div>
  )
}

/** Map raw API message to frontend Message type */
function mapMsg(m: any) {
  const segments = (() => {
    try {
      const raw = typeof m.segments === 'string' ? JSON.parse(m.segments || '[]') : (m.segments || [])
      return Array.isArray(raw) ? raw.filter((x: unknown) => typeof x === 'string' && x.trim()) : []
    } catch {
      return []
    }
  })()
  return {
    id: m.id,
    author: m.author,
    content: m.content,
    bot: m.author !== 'Du',
    ts: m.ts,
    edited_at: m.edited_at || null,
    reactions: m.reactions || [],
    elapsedMs: typeof m.elapsed_ms === 'number' ? m.elapsed_ms : null,
    inputTokens: typeof m.input_tokens === 'number' ? m.input_tokens : 0,
    outputTokens: typeof m.output_tokens === 'number' ? m.output_tokens : 0,
    incomplete: !!m.incomplete,
    attachments: (() => { try { return typeof m.attachments === 'string' ? JSON.parse(m.attachments || '[]') : (m.attachments || []) } catch { return [] } })(),
    tools: (() => { try { const t = JSON.parse(m.tools || '[]'); return t.length ? t.map((x: any) => ({ ...x, status: 'completed' })) : undefined } catch { return undefined } })(),
    segments: segments.length ? segments : undefined,
  }
}

// DB-Reload mergen statt überschreiben: laufende Streams (Snapshot oder Live) füllen
// die letzte Bot-Message mit Tools, der DB-Reload hat sie aber noch nicht gespeichert
// (update_partial schreibt nur Text). Wir bewahren Tool/Content der Live-State, falls
// DB nach Snapshot eintrifft.
function mergeLiveTools(prev: any[], dbMsgs: any[]): any[] {
  const liveById = new Map<number, any>()
  let trailingLive: any | null = null
  const recentLocal = prev.filter(m => (
    m?.id === undefined &&
    m?.ts &&
    Date.now() / 1000 - m.ts < 30 &&
    typeof m.content === 'string'
  ))
  for (let i = 0; i < prev.length; i++) {
    const m = prev[i]
    if (!m?.bot) continue
    if (m.id !== undefined) {
      const hasTools = (m.tools?.length || 0) > 0
      const hasLiveState = hasTools || !!m.content || (m.steps?.length || 0) > 0 || (m.segments?.length || 0) > 0 || !!m.incomplete
      if (hasLiveState) liveById.set(m.id, m)
    } else if (i === prev.length - 1) {
      // Letzte streamende Bot-Message ohne id bewahren — aber NUR wenn sie
      // wirklich live ist. Der localStorage-Cache (slim: nur author/content/bot/ts)
      // hat weder steps/tools/segments/incomplete; eine alte gecachte Bot-Antwort
      // darf nicht als "trailingLive" hinten drangeklebt werden (Geister-Nachricht).
      // Echter Stream hat immer steps/tools/segments oder einen frischen ts.
      const hasTools = (m.tools?.length || 0) > 0
      const hasLiveState = hasTools || (m.steps?.length || 0) > 0 || (m.segments?.length || 0) > 0 || !!m.incomplete
      const isFresh = !!m.ts && (Date.now() / 1000 - m.ts < 30)
      if (hasLiveState || isFresh) trailingLive = m
    }
  }
  if (liveById.size === 0 && !trailingLive && recentLocal.length === 0) return dbMsgs
  let out = dbMsgs.map(db => {
    if (db.id === undefined) return db
    const live = liveById.get(db.id)
    if (!live) return db
    const dbTools = db.tools || []
    const liveTools = live.tools || []
    const useTools = liveTools.length > dbTools.length ? liveTools : dbTools
    const useContent = (live.content && live.content.length > (db.content?.length || 0)) ? live.content : db.content
    const liveSegments = live.segments || []
    const dbSegments = db.segments || []
    const useSegments = liveSegments.length > dbSegments.length ? liveSegments : dbSegments
    const liveSteps = live.steps || []
    const dbSteps = db.steps || []
    // Nach Gesamttextlaenge waehlen, nicht nach Step-Anzahl: eine lueckenhafte
    // Live-Version (mehr, aber kuerzere steps) darf die vollstaendige DB-Version
    // nicht verdraengen.
    const stepsTextLen = (steps: ChatStep[]) => steps.reduce((n, s) => n + (s.kind === 'text' ? s.text.length : 0), 0)
    const liveStepTools = liveSteps.filter((s: ChatStep) => s.kind === 'tool').length
    const dbStepTools = dbSteps.filter((s: ChatStep) => s.kind === 'tool').length
    const useSteps = (liveStepTools > dbStepTools || stepsTextLen(liveSteps) > stepsTextLen(dbSteps)) ? liveSteps : dbSteps
    const useThinking = live.thinking && String(live.thinking).length > String(db.thinking || '').length ? live.thinking : db.thinking
    return { ...db, tools: useTools, content: useContent, segments: useSegments, steps: useSteps, thinking: useThinking }
  })
  if (trailingLive) {
    const tail = out[out.length - 1]
    if (tail && tail.bot) {
      const tailTools = tail.tools || []
      const liveTools = trailingLive.tools || []
      const useTools = liveTools.length > tailTools.length ? liveTools : tailTools
      const useContent = (trailingLive.content && trailingLive.content.length > (tail.content?.length || 0)) ? trailingLive.content : tail.content
      const tailSegments = tail.segments || []
      const liveSegments = trailingLive.segments || []
      const useSegments = liveSegments.length > tailSegments.length ? liveSegments : tailSegments
      out = [...out.slice(0, -1), { ...tail, tools: useTools, content: useContent, segments: useSegments }]
    } else {
      out = [...out, trailingLive]
    }
  }
  const hasSameVisibleMessage = (arr: any[], msg: any) => arr.some(existing => (
    existing.author === msg.author &&
    !!existing.bot === !!msg.bot &&
    String(existing.content || '') === String(msg.content || '')
  ))
  for (const msg of recentLocal) {
    if (!hasSameVisibleMessage(out, msg)) out = [...out, msg]
  }
  return out
}

function chatAge(ts: number): string {
  if (!ts) return ''
  const s = Date.now() / 1000 - ts
  if (s < 60) return 'gerade'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 172800) return 'gestern'
  const d = new Date(ts * 1000)
  return `${d.getDate()}. ${d.toLocaleString('de', { month: 'short' })}`
}

function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

interface MobileChatConv {
  id: string
  agent: string
  title: string
  updated_at: number
  project?: string
  highlight?: boolean
}

interface MobileChatProject {
  id: string
  name: string
  chatCount: number
  updated_at: number
}

function MobileChatSheet({ agent, conversationId, conversations, archivedChats, projects, unreadConvs, busyConvs, isActive, mobileSlotIndicator, onConvChange, onNewChat, onRenameChat, onArchiveChat, onRestoreChat, onLoadArchive }: {
  agent: string; conversationId?: string; conversations: MobileChatConv[]; archivedChats: MobileChatConv[]; projects: MobileChatProject[]; unreadConvs: Set<string>; busyConvs: Set<string>; isActive: boolean; mobileSlotIndicator?: ReactNode; onConvChange: (convId: string, agent: string) => void; onNewChat: (agent: string, project?: string) => void; onRenameChat: (convId: string, title: string) => void; onArchiveChat: (convId: string) => void; onRestoreChat: (convId: string) => void; onLoadArchive: () => void
}) {
  const [open, setOpen] = useState(false)
  // Sheet wird über Window-Event vom MobileTopBar ausgelöst — nur der aktive Slot reagiert.
  useEffect(() => {
    const handler = () => { if (isActive) setOpen(prev => !prev) }
    window.addEventListener('deck:openConvSheet', handler)
    return () => window.removeEventListener('deck:openConvSheet', handler)
  }, [isActive])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [search, setSearch] = useState('')
  const [showArchive, setShowArchive] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const sourceChats = showArchive ? archivedChats : conversations
  const allChats = sourceChats.filter(c =>
    (c.agent === 'main' || c.agent === 'claude' || c.agent.startsWith('claude-')) && !c.id.startsWith('channel-')
  )
  const { hits: semanticHits } = useConversationSearch(search)
  const semanticOrder = (() => {
    if (!semanticHits) return null
    const m = new Map<string, number>()
    semanticHits.forEach((h, i) => m.set(h.conversationId, i))
    return m
  })()
  const localMatches = (c: MobileChatConv) =>
    fuzzyIncludes(c.title || '', search) || fuzzyIncludes(projects.find(p => p.id === c.project)?.name || '', search)
  const filtered = search.trim()
    ? semanticOrder
      ? [...allChats]
          .filter(c => semanticOrder.has(c.id) || localMatches(c))
          .sort((a, b) => {
            const ai = semanticOrder.has(a.id) ? semanticOrder.get(a.id)! : Number.MAX_SAFE_INTEGER
            const bi = semanticOrder.has(b.id) ? semanticOrder.get(b.id)! : Number.MAX_SAFE_INTEGER
            if (ai !== bi) return ai - bi
            return b.updated_at - a.updated_at
          })
      : allChats.filter(localMatches)
    : allChats

  const d = new Date()
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000
  const yesterdayStart = todayStart - 86400
  const weekAgo = todayStart - 7 * 86400
  const timeGroups: { label: string; chats: MobileChatConv[] }[] = [
    { label: 'Heute', chats: [] },
    { label: 'Gestern', chats: [] },
    { label: 'Letzte 7 Tage', chats: [] },
    { label: 'Älter', chats: [] },
  ]
  for (const c of [...filtered].sort((a, b) => b.updated_at - a.updated_at)) {
    if (c.updated_at >= todayStart) timeGroups[0].chats.push(c)
    else if (c.updated_at >= yesterdayStart) timeGroups[1].chats.push(c)
    else if (c.updated_at >= weekAgo) timeGroups[2].chats.push(c)
    else timeGroups[3].chats.push(c)
  }
  const commitRename = (convId: string) => {
    if (editTitle.trim()) onRenameChat(convId, editTitle.trim())
    setEditingId(null)
  }

  useEffect(() => {
    if (open) { setSearch(''); setShowArchive(false); setTimeout(() => searchRef.current?.focus(), 50) }
  }, [open])

  // Body-Scroll-Lock + Page-Swipe-Block solange das Sheet offen ist —
  // verhindert, dass der darunter liegende transformierte Container mitspringt.
  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    const prevTouch = document.body.style.touchAction
    document.body.style.overflow = 'hidden'
    document.body.style.touchAction = 'none'
    return () => {
      document.body.style.overflow = prevOverflow
      document.body.style.touchAction = prevTouch
    }
  }, [open])

  const renderChat = (c: MobileChatConv) => {
    const isCurrent = !showArchive && c.id === conversationId
    const isUnread = !showArchive && unreadConvs.has(c.id)
    const isBusy = !showArchive && busyConvs.has(c.id)
    const isHighlight = !showArchive && !!c.highlight && c.id !== conversationId
    const isEditing = editingId === c.id
    return (
      <div key={c.id} className={`group relative flex items-center gap-3 py-4 px-5 text-[19px] transition-colors ${
        isCurrent ? 'text-[var(--t1)]' : isHighlight ? 'text-[#d97757] active:bg-white/[0.03]' : (isUnread || isBusy) ? 'text-[var(--t1)] active:bg-white/[0.03]' : 'text-[var(--t2)] active:bg-white/[0.03]'
      }`}>
        {isCurrent && <span className="absolute left-2.5 top-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-[#d97757]" />}
        {isEditing ? (
          <input autoFocus value={editTitle} onChange={e => setEditTitle(e.target.value)}
            onBlur={() => commitRename(c.id)}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingId(null) }}
            className="flex-1 bg-transparent border-b border-[var(--border)] outline-none text-[19px] text-[var(--t1)] py-0 min-w-0"
            onClick={e => e.stopPropagation()} />
        ) : showArchive ? (
          <span className="flex-1 truncate text-[var(--t3)] min-w-0">{c.title || 'Neuer Chat'}</span>
        ) : (
          <button onClick={() => {
            if (c.highlight) {
              fetch(`/api/conversations/${c.id}/seen`, { method: 'POST' }).catch(() => {})
              setTimeout(() => window.dispatchEvent(new CustomEvent('deck:chatsChanged')), 150)
            }
            onConvChange(c.id, c.agent); setOpen(false)
          }}
            className="flex-1 text-left truncate cursor-pointer min-w-0">
            {c.title || 'Neuer Chat'}
          </button>
        )}
        {!isEditing && !isCurrent && (
          <div className="flex items-center gap-1.5 text-[15px] text-[var(--t3)] flex-shrink-0">
            <span className="tabular-nums text-[16px]">{chatAge(c.updated_at)}</span>
          </div>
        )}
        {!isEditing && isCurrent && !showArchive && (
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <button className="p-1.5 rounded text-[var(--t3)] active:text-[var(--t2)] transition-colors cursor-pointer"
              onClick={e => { e.stopPropagation(); setEditingId(c.id); setEditTitle(c.title || '') }} title="Umbenennen">
              <Pencil className="w-4 h-4" />
            </button>
            <button className="p-1.5 rounded text-[var(--t3)] active:text-[var(--t2)] transition-colors cursor-pointer"
              onClick={e => { e.stopPropagation(); onArchiveChat(c.id) }} title="Archivieren">
              <Archive className="w-4 h-4" />
            </button>
          </div>
        )}
        {showArchive && (
          <button className="p-1.5 rounded text-[var(--t3)] active:text-[var(--t2)] transition-colors flex-shrink-0 cursor-pointer"
            onClick={e => { e.stopPropagation(); onRestoreChat(c.id) }} title="Wiederherstellen">
            <ArchiveRestore className="w-4 h-4" />
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      {open && createPortal(
        <div
          className="fixed inset-0 z-50 bg-[var(--bg)] flex flex-col animate-[fadeIn_0.1s_ease] overflow-hidden"
          style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
        >
            <div className="mobile-hero-chrome flex-shrink-0 bg-[var(--bg)]">
              <div className="flex items-center gap-2 px-5 pt-[1px] pb-[5px] min-h-[28px]">
                <div
                  className="flex-1 min-w-0 truncate text-[15px] leading-[1.1] text-[var(--t3)]"
                  style={{ fontFamily: 'var(--font-body)', letterSpacing: '0.02em' }}
                >
                  {showArchive ? 'Archiv' : 'Chats'}
                </div>
                <button
                  onClick={e => { e.stopPropagation(); const next = !showArchive; setShowArchive(next); setSearch(''); if (next) onLoadArchive() }}
                  className={`flex h-7 w-7 items-center justify-center rounded-full active:text-[var(--t1)] cursor-pointer ${
                    showArchive ? 'text-[#d97757]' : 'text-[var(--t3)]'
                  }`}
                  title={showArchive ? 'Aktive Chats' : 'Archiv'}
                  aria-label={showArchive ? 'Aktive Chats' : 'Archiv'}
                >
                  <Archive className="w-[20px] h-[20px]" strokeWidth={1.75} />
                </button>
              </div>
            </div>

            <div className="overflow-y-auto overflow-x-hidden flex-1 min-h-0">
              <div className="h-2" />
              {(() => {
                const nonEmpty = timeGroups.filter(g => g.chats.length > 0)
                if (nonEmpty.length === 0) {
                  return (
                    <div className="px-4 py-12 text-center text-[16px] text-[var(--t3)]">
                      {search ? 'Keine Treffer' : showArchive ? 'Kein Archiv' : 'Noch keine Chats'}
                    </div>
                  )
                }
                return nonEmpty.map(g => (
                  <div key={g.label} className="mt-1 first:mt-0">
                    <div className="px-5 pt-5 pb-1.5 text-[16px] text-[var(--t3)]">{g.label}</div>
                    <div className="mx-5 h-px bg-[var(--mobile-chrome-border)] opacity-70" />
                    {g.chats.map(renderChat)}
                  </div>
                ))
              })()}
              <div className="h-7" />
            </div>

            <div
              className="composer-mobile-wrap relative rounded-b-none border-t border-x-0 border-b-0 px-5 flex-shrink-0"
              style={{
                background: 'var(--bg)',
                borderTopLeftRadius: 0,
                borderTopRightRadius: 0,
                paddingTop: 4,
                paddingBottom: 'max(0px, calc(env(safe-area-inset-bottom, 0px) - 22px))',
              }}
            >
              <div className="relative flex items-center" style={{ minHeight: 32 }}>
                <div className="w-full">{mobileSlotIndicator}</div>
              </div>
              <div
                className="grid items-center gap-3 pt-0 pb-0"
                style={{ marginTop: 6, gridTemplateColumns: '52px 1fr 52px' }}
              >
                <div className="flex items-center justify-start overflow-hidden">
                  <button
                    onClick={e => { e.stopPropagation(); setOpen(false) }}
                    className="flex h-[54px] w-[54px] items-center justify-center rounded-full text-[var(--t2)] active:text-[var(--t1)] cursor-pointer"
                    title="Schließen"
                    aria-label="Schließen"
                  >
                    <X className="w-7 h-7" strokeWidth={2.25} />
                  </button>
                </div>

                <div className="flex items-center justify-center h-[58px] relative">
                  <Search className="absolute left-0 top-1/2 -translate-y-1/2 w-[24px] h-[24px] text-[var(--t3)] pointer-events-none" strokeWidth={1.75} />
                  <input
                    ref={searchRef}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder={showArchive ? 'Archiv suchen' : 'Chat suchen'}
                    className="absolute left-8 right-0 top-1/2 -translate-y-1/2 bg-transparent border-0 outline-none text-[20px] text-[var(--t1)] placeholder:text-[var(--t3)] leading-[24px] py-1 min-w-0"
                  />
                </div>

                <div className="flex items-center justify-end gap-0">
                  <button
                    onClick={e => { e.stopPropagation(); onNewChat(agent); setOpen(false) }}
                    className="flex h-[54px] w-[54px] items-center justify-center rounded-full text-[var(--t2)] active:text-[var(--t1)] cursor-pointer"
                    title="Neuer Chat"
                    aria-label="Neuer Chat"
                  >
                    <Plus className="w-8 h-8" strokeWidth={2.45} />
                  </button>
                </div>
            </div>
          </div>
          </div>,
        document.body
      )}
    </>
  )
}

interface ToolCall {
  name: string
  input: Record<string, unknown>
  id: string
  result?: string
  status?: string
  output?: string
  diffStats?: { added: number; removed: number }
}

interface MemoryRef {
  source: string
  path: string
  title: string
  snippet: string
  color: string
}

type ChatStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolCall }

interface Message {
  id?: number
  author: string
  content: string
  bot?: boolean
  ts?: number
  edited_at?: number
  attachments?: Attachment[]
  tools?: ToolCall[]
  thinking?: string
  refs?: MemoryRef[]
  steps?: ChatStep[]
  segments?: string[]
  incomplete?: boolean
  elapsedMs?: number | null
  inputTokens?: number
  outputTokens?: number
}

interface ChatHistoryCacheEntry {
  messages: Message[]
  history: { role: string; content: string }[]
  limit: number
  fetchedAt: number
}

const CHAT_HISTORY_CACHE_TTL_MS = 5 * 60_000
const CHAT_HISTORY_REFETCH_COOLDOWN_MS = 5_000
const chatHistoryCache = new Map<string, ChatHistoryCacheEntry>()
const historyRequests = new Map<string, Promise<any>>()
const CHAT_TRACE_LIMIT = 200
let chatTracePostTimer: ReturnType<typeof setTimeout> | null = null

function chatTrace(stage: string, detail: Record<string, unknown> = {}) {
  if (typeof window === 'undefined') return
  // No-op im Normalbetrieb: ohne aktives Debug-Flag kein Array-Aufbau, kein
  // localStorage und vor allem kein client-metrics-Post. Das pro Stream-Snapshot
  // gefeuerte Tracing war ein Dauer-Request-Sturm, der den Desktop ausbremste.
  try { if (localStorage.getItem('deck:chatTrace') !== '1') return } catch { return }
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const w = window as any
  const pageId = w.__deckChatTracePageId || (w.__deckChatTracePageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  const event = {
    at: new Date().toISOString(),
    t: Math.round(now),
    pageId,
    stage,
    ...detail,
  }
  const events = Array.isArray(w.__deckChatTrace)
    ? w.__deckChatTrace
    : (() => {
        try {
          const parsed = JSON.parse(localStorage.getItem('deck:chatTraceLog') || '[]')
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      })()
  events.push(event)
  if (events.length > CHAT_TRACE_LIMIT) events.splice(0, events.length - CHAT_TRACE_LIMIT)
  w.__deckChatTrace = events
  try {
    // Nur im Debug-Modus persistieren: der synchrone setItem mit JSON.stringify
    // lief sonst pro Stream-Snapshot und blockierte den Main-Thread (UI-Ruckeln).
    if (localStorage.getItem('deck:chatTrace') === '1') {
      localStorage.setItem('deck:chatTraceLog', JSON.stringify(events))
      console.info('[chat-trace]', event)
    }
  } catch {}
  if (!chatTracePostTimer) {
    chatTracePostTimer = window.setTimeout(() => {
      chatTracePostTimer = null
      const latest = Array.isArray(w.__deckChatTrace) ? w.__deckChatTrace.slice(-CHAT_TRACE_LIMIT) : []
      fetch('/api/chatagent/client-metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: window.location.href,
          viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
          events: latest,
        }),
        keepalive: true,
      }).catch(() => {})
    }, 1200)
  }
  window.dispatchEvent(new CustomEvent('deck:chatTrace', { detail: event }))
}

function historyFromMessages(messages: Message[]): { role: string; content: string }[] {
  return messages.map(m => ({ role: m.author === 'Du' ? 'user' : 'assistant', content: m.content }))
}

function readLocalChatMessages(cid: string): Message[] {
  if (!cid || typeof localStorage === 'undefined') return []
  try {
    const parsed = JSON.parse(localStorage.getItem(`deck:msgs:${cid}`) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((m: any) => m && typeof m.author === 'string' && typeof m.content === 'string')
      .map((m: any) => ({
        author: m.author,
        content: m.content,
        bot: typeof m.bot === 'boolean' ? m.bot : m.author !== 'Du',
        ts: typeof m.ts === 'number' ? m.ts : undefined,
      }))
  } catch {
    return []
  }
}

function updateChatHistoryCache(cid: string, messages: Message[], limit = 100) {
  if (!cid || cid.startsWith('channel-')) return
  const cachedMessages = messages.slice(-Math.max(limit, messages.length))
  chatHistoryCache.set(cid, {
    messages: cachedMessages,
    history: historyFromMessages(cachedMessages),
    limit: Math.max(limit, cachedMessages.length),
    fetchedAt: Date.now(),
  })
}

function getChatHistoryCache(cid: string, limit = 100): ChatHistoryCacheEntry | null {
  const cached = chatHistoryCache.get(cid)
  if (!cached) return null
  if (Date.now() - cached.fetchedAt > CHAT_HISTORY_CACHE_TTL_MS) return null
  if (cached.limit < limit && cached.messages.length >= cached.limit) return null
  return cached
}

function fetchHistoryData(cid: string, limit = 100): Promise<any> {
  const key = `${cid}:${limit}`
  const existing = historyRequests.get(key)
  if (existing) {
    chatTrace('history.fetch.reuse', { conversationId: cid, limit })
    return existing
  }
  chatTrace('history.fetch.start', { conversationId: cid, limit })
  const request = fetch(`/api/history?conversation_id=${encodeURIComponent(cid)}&limit=${limit}`)
    .then(r => r.json())
    .then(data => {
      chatTrace('history.fetch.done', {
        conversationId: cid,
        limit,
        messages: Array.isArray(data?.messages) ? data.messages.length : 0,
      })
      return data
    })
    .catch(err => {
      chatTrace('history.fetch.error', { conversationId: cid, limit, error: String(err?.message || err || '') })
      throw err
    })
    .finally(() => { historyRequests.delete(key) })
  historyRequests.set(key, request)
  return request
}

const AGENTS: Record<string, { name: string }> = Object.fromEntries(
  getAllAgentsIncludingHidden().map(a => [a.id, { name: a.name }])
)

// Erkennt, ob die letzte Agent-Antwort auf eine kurze Bestätigung wartet ("Soll ich
// das so bauen?", "Loslegen?"). Heuristik: letzte 300 Zeichen müssen mit "?" enden
// und einen Trigger enthalten — sonst fühlt sich der Haken aufgedrängt an.
function detectConfirmationPrompt(text: string): boolean {
  if (!text) return false
  const tail = text.toLowerCase().slice(-400).trimEnd()
  if (!tail.endsWith('?')) return false
  const triggers = [
    'soll ich',
    'mach ich',
    'machen wir',
    'baue ich',
    'baue das',
    'umsetzen?',
    'umsetzen.',
    'umzusetzen',
    'loslegen',
    'leg ich los',
    'lege ich los',
    'leg los',
    'starte ich',
    'starten?',
    'so okay',
    'so passt',
    'passt das',
    'passt so',
    'klingt gut',
    'einverstanden',
    'so bauen',
    'so machen',
    'übernehme ich',
    'übernehmen',
    'go?',
    'okay so',
    'ok so',
  ]
  return triggers.some(t => tail.includes(t))
}

// Fester Futter-Bereich unten in der Desktop-Pane: spiegelt den Titlebar oben
// (gleiche Linie, gleiche Höhe, gleiche Textdimension), liegt immer an derselben
// Stelle. Läuft → Zeit + Status + Tacho; fertig → derselbe Stand bleibt mit
// Gesamtdauer und Fertig-Uhrzeit stehen. Stopp nur als schwaches Icon bei Hover.
// Einzelne Ziffer, die beim Wechsel vertikal nachrollt (Flipboard, wie Codex).
// Reine CSS-Transition auf einer 0–9-Spalte, kein State, font-size-unabhängig.
function RollDigit({ d }: { d: number }) {
  return (
    <span style={{ display: 'inline-block', height: '1em', lineHeight: '1em', overflow: 'hidden', verticalAlign: 'middle' }}>
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          transform: `translateY(-${d}em)`,
          transition: 'transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
          <span key={n} style={{ height: '1em', lineHeight: '1em' }}>{n}</span>
        ))}
      </span>
    </span>
  )
}

// Ganze Zahl als Folge rollender Ziffern.
function RollingNumber({ value }: { value: number }) {
  const digits = String(Math.max(0, Math.round(value))).split('')
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {digits.map((ch, i) => <RollDigit key={`${digits.length}:${i}`} d={Number(ch)} />)}
    </span>
  )
}

function tallyIconFor(label: string): LucideIcon {
  if (label.includes('Datei')) return FileText
  if (label.includes('Suche')) return Eye
  if (label.includes('Änderung')) return Pencil
  if (label.includes('Check')) return Search
  if (label.includes('Quelle')) return Globe
  if (label.includes('Meinung')) return Bot
  return ListChecks
}

function tallyTooltip(label: string, count: number): string {
  if (label.includes('Datei')) return `${count} ${label}: ich lese oder prüfe Dateien im Projekt.`
  if (label.includes('Suche')) return `${count} ${label}: ich suche im Projekt nach passenden Stellen.`
  if (label.includes('Änderung')) return `${count} ${label}: ich passe Dateien an.`
  if (label.includes('Check')) return `${count} ${label}: ich führe einen lokalen Check oder Befehl aus.`
  if (label.includes('Quelle')) return `${count} ${label}: ich prüfe externe Webquellen.`
  if (label.includes('Meinung')) return `${count} ${label}: ein zweiter Agent prüft parallel.`
  return `${count} ${label}`
}

function formatTokenCount(value: number): string {
  const n = Math.max(0, Math.round(value))
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace('.', ',')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace('.', ',')}K`
  return String(n)
}

const MAX_VISIBLE_RUN_TOKENS = 900_000

function visibleTokenPart(value: unknown): number {
  const n = typeof value === 'number' ? Math.max(0, Math.round(value)) : 0
  return n >= MAX_VISIBLE_RUN_TOKENS ? 0 : n
}

function tokenTotalFromUsage(msg: any): number {
  const input = visibleTokenPart(msg.inputTokens)
  const output = visibleTokenPart(msg.outputTokens)
  return input + output
}

function werkbankTaskSeconds(task: WerkbankFooterTask): number {
  const elapsed = Number(task.metrics?.elapsed_ms || 0)
  if (elapsed > 0) return Math.max(0, Math.round(elapsed / 1000))
  if (task.status === 'done' && task.created_at && task.updated_at) {
    return Math.max(0, Math.round(Number(task.updated_at) - Number(task.created_at)))
  }
  const start = Number(task.created_at || task.updated_at || 0)
  if (!start) return 0
  return Math.max(0, Math.floor(Date.now() / 1000 - start))
}

function werkbankFooterStatus(tasks: WerkbankFooterTask[]): WerkbankFooterStatus | null {
  if (!tasks.length) return null
  const active = [
    ...tasks.filter(t => t.status === 'running'),
    ...tasks.filter(t => t.status === 'queued'),
  ]
  const needsInput = tasks.filter(t => String(t.status || '') === 'needs_input')
  const blocked = tasks.filter(t => ['blocked', 'rate_limited'].includes(String(t.status || '')))
  const needsWork = tasks.filter(t => String(t.status || '') === 'needs_work')
  const attention = [...needsInput, ...blocked, ...needsWork]
  const open = [...attention, ...active]
  const suffix = open.length > 1 ? ` · +${open.length - 1}` : ''
  if (attention.length) {
    const first = attention[0]
    const labelBase = needsInput.length
      ? 'wartet auf Entscheidung'
      : blocked.length
        ? 'blockiert'
        : 'Nacharbeit offen'
    return {
      label: `${labelBase} · ${fmtDur(werkbankTaskSeconds(first))}${suffix}`,
      title: attention.map(t => t.title || t.id).join(' · '),
      tone: 'needs-input',
      taskId: first.id,
    }
  }
  if (active.length) {
    const first = active[0]
    return {
      label: `${fmtDur(werkbankTaskSeconds(first))}${suffix}`,
      title: active.map(t => t.title || t.id).join(' · '),
      tone: 'active',
      taskId: first.id,
    }
  }
  const done = tasks.filter(t => t.status === 'done')
  if (done.length) {
    const first = done[0]
    return {
      label: fmtDur(werkbankTaskSeconds(first)),
      title: `Fertig: ${done.map(t => t.title || t.id).join(' · ')}`,
      tone: 'done',
      taskId: first.id,
    }
  }
  return null
}

function PaneLiveFooter({ busy, elapsedSeconds, statusLabel, tools, doneMs, tokenCount, inputTokens, outputTokens, queueItems, onRemoveQueueItem, onMoveQueueItem, onClearQueue, werkbankTasks, onStop, paneSwitcher }: {
  busy: boolean
  elapsedSeconds: number
  statusLabel?: string
  tools: ToolCall[]
  doneMs?: number | null
  tokenCount: number
  inputTokens: number
  outputTokens: number
  queueItems: { id: string; text: string }[]
  onRemoveQueueItem: (id: string) => void
  onMoveQueueItem: (id: string, direction: -1 | 1) => void
  onClearQueue: () => void
  werkbankTasks: WerkbankFooterTask[]
  onStop: () => void
  paneSwitcher?: ReactNode
}) {
  // Kollaps-Modus: Die Footer-Zeile trägt statt Zeit/Token/Zeilen die über die
  // volle Breite verteilte Switch-Leiste mit den Pane-Punkten.
  if (paneSwitcher) {
    return (
      <div
        className="chat-pane-footerbar relative flex-shrink-0 w-full flex items-center min-h-[var(--header-row-h)] px-6"
        style={{ backgroundColor: 'var(--bg)' }}
      >
        {paneSwitcher}
      </div>
    )
  }
  const queueLength = queueItems.length
  const [queueOpen, setQueueOpen] = useState(false)
  // Popover schliessen, sobald die Queue leer ist (letzter Eintrag entfernt/abgearbeitet).
  useEffect(() => { if (queueLength === 0) setQueueOpen(false) }, [queueLength])
  const tally = buildTallyItems(tools as unknown as Parameters<typeof buildTallyItems>[0])
  const lineItem = tally.find(it => it.label === 'Zeilen')
  const restItems = tally.filter(it => it.label !== 'Zeilen' && typeof it.count === 'number')

  // Geschriebener Code (Zeilen) steht immer direkt hinter der Zeit — grün/rot
  // mit Slash, mit live rollenden Zahlen. Dann der Status, dann der Rest.
  const added = lineItem?.added || 0
  const removed = lineItem?.removed || 0
  const hasLines = added > 0 || removed > 0

  const segs: { type: 'werkbank' | 'time' | 'tokens' | 'lines' | 'status' | 'rest' | 'queue'; title?: string; node: ReactNode }[] = []
  const werkbank = werkbankFooterStatus(werkbankTasks)
  const openWerkbankTask = (taskId?: string) => {
    if (!taskId) return
    window.dispatchEvent(new CustomEvent('deck:startWerkbank', { detail: { view: 'werkbank', werkbank_task_id: taskId } }))
  }
  if (werkbank) {
    segs.push({ type: 'werkbank', title: werkbank.title, node: (
      <span
        title={werkbank.title}
        aria-label={werkbank.label}
        role={werkbank.taskId ? 'button' : undefined}
        tabIndex={werkbank.taskId ? 0 : undefined}
        onClick={() => openWerkbankTask(werkbank.taskId)}
        onKeyDown={(e) => {
          if (!werkbank.taskId) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openWerkbankTask(werkbank.taskId)
          }
        }}
        className={`werkbank-footer-status is-${werkbank.tone}${werkbank.taskId ? ' is-clickable' : ''}`}
      >
        <Hammer size={11} strokeWidth={2.2} aria-hidden="true" />
        <span>{werkbank.label}</span>
        {werkbank.tone === 'done' && <Check size={12} strokeWidth={2.6} aria-hidden="true" />}
      </span>
    ) })
  }
  // Zeit zuerst. Im Ruhezustand zeigt doneMs, wie lange der letzte Lauf dauerte —
  // immer als Zahl (auch 0), damit konsequent "0s" statt nichts steht. Nur wenn es
  // gar keinen fertigen Lauf gibt (doneMs null), bleibt der Footer leer.
  const dur = busy
    ? fmtDur(Math.max(0, Math.round(elapsedSeconds)))
    : doneMs != null ? fmtDur(Math.max(0, Math.round(doneMs / 1000))) : ''
  // Während der Arbeit schimmert nur die Zeit warm. Alle Zählsegmente bleiben
  // ruhig, damit der Footer nicht nach mehreren gleichzeitigen Statusfarben wirkt.
  const warm = busy ? 'status-shimmer-warm' : ''
  if (dur) {
    const timeTitle = busy ? `Laufzeit: ${dur}` : `Letzter Lauf: ${dur}`
    segs.push({ type: 'time', title: timeTitle, node: <span className={`leading-none ${warm}`} title={timeTitle}>{dur}</span> })
  }
  if (tokenCount > 0) {
    const tokenTitle = inputTokens > 0 || outputTokens > 0
      ? `${tokenCount} Tokens sichtbar (${inputTokens} rein, ${outputTokens} raus).`
      : `${tokenCount} Tokens sichtbar.`
    segs.push({ type: 'tokens', node: (
      <span
        title={tokenTitle}
        aria-label={tokenTitle}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.24em' }}
      >
        <span>{formatTokenCount(tokenCount)}</span>
        <span aria-hidden="true" style={{ fontSize: 12, lineHeight: 1, fontWeight: 650 }}>T</span>
      </span>
    ), title: tokenTitle })
  }
  // Code direkt dahinter
  if (hasLines) {
    const lineTitle = `Code geändert: ${added > 0 ? `+${added}` : ''}${added > 0 && removed > 0 ? ' / ' : ''}${removed > 0 ? `-${removed}` : ''} Zeilen.`
    segs.push({ type: 'lines', node: (
      <span title={lineTitle} aria-label={lineTitle} style={{ display: 'inline-flex', alignItems: 'center' }}>
        {added > 0 && (
          <span style={{ color: 'var(--diff-add)', display: 'inline-flex', alignItems: 'center' }}>+<RollingNumber value={added} /></span>
        )}
        {added > 0 && removed > 0 && <span style={{ opacity: 0.5, padding: '0 0.3em' }}>/</span>}
        {removed > 0 && (
          <span style={{ color: 'var(--diff-del)', display: 'inline-flex', alignItems: 'center' }}>-<RollingNumber value={removed} /></span>
        )}
      </span>
    ), title: lineTitle })
  }
  // Kein generisches "Denke nach" mehr — solange der Footer schimmert und die
  // Zahlen laufen, ist klar, dass gearbeitet wird. Nur ein echtes Phase-Label
  // (z. B. einer Job-Phase) wird gezeigt, sonst nichts.
  if (busy && statusLabel && statusLabel.trim() && statusLabel.trim() !== 'Denke nach') {
    const statusTitle = `Aktueller Schritt: ${statusLabel.trim()}`
    segs.push({ type: 'status', title: statusTitle, node: <span title={statusTitle}>{statusLabel.trim()}</span> })
  }
  // Rest (Dateien, Checks, ...) nachrangig und bewusst neutral. Die laufende
  // Zeit ist der einzige aktive Akzent.
  restItems.forEach((it, i) => {
    const Icon = tallyIconFor(it.label)
    const title = tallyTooltip(it.label, it.count || 0)
    segs.push({ type: 'rest', node: (
      <span
        key={`rest:${i}`}
        title={title}
        aria-label={title}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.24em' }}
      >
        <RollingNumber value={it.count || 0} />
        <Icon size={12} strokeWidth={2.2} aria-hidden="true" />
      </span>
    ), title })
  })
  // Queue: wie viele Nachrichten warten. Lebt jetzt hier in der Arbeitszeile,
  // nicht mehr als Badge am Plus-Button.
  if (queueLength > 0) {
    const queueLabel = `+${queueLength} Q`
    const queueTitle = `${queueLength} in Queue: so viele Nachrichten warten nach diesem Lauf.`
    segs.push({ type: 'queue', node: (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setQueueOpen(o => !o) }}
        title={queueTitle}
        aria-label={queueTitle}
        aria-expanded={queueOpen}
        className={`queue-pill-trigger ${busy ? 'busy-pill-pulse' : ''}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.12em', fontWeight: 750, color: 'var(--cc-orange)', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
      >
        <span aria-hidden="true">+</span>
        <RollingNumber value={queueLength} />
        <span aria-hidden="true" style={{ fontSize: 12, lineHeight: 1, fontWeight: 650 }}>Q</span>
        <span className="sr-only">{queueLabel}</span>
      </button>
    ), title: queueTitle })
  }

  // Plain-String parallel für den Hover-Tooltip (zeigt den vollen Stand).
  const titleParts: string[] = []
  if (werkbank) titleParts.push(werkbank.label)
  if (dur) titleParts.push(dur)
  if (tokenCount > 0) {
    titleParts.push(inputTokens > 0 || outputTokens > 0
      ? `${tokenCount} Tokens (${inputTokens} rein, ${outputTokens} raus)`
      : `${tokenCount} Tokens`)
  }
  if (hasLines) titleParts.push([added > 0 ? `+${added}` : '', removed > 0 ? `-${removed}` : ''].filter(Boolean).join(' / '))
  if (busy && statusLabel && statusLabel.trim() && statusLabel.trim() !== 'Denke nach') titleParts.push(statusLabel.trim())
  restItems.forEach(it => titleParts.push(tallyTooltip(it.label, it.count || 0)))
  if (queueLength > 0) titleParts.push(`${queueLength} in Queue`)
  const fullText = titleParts.join('  ·  ')

  return (
    <div
      className="chat-pane-footerbar group relative flex-shrink-0 w-full flex items-center min-h-[var(--header-row-h)]"
      style={{ backgroundColor: 'var(--bg)' }}
    >
      <div
        className="flex-1 min-w-0 flex items-center gap-0 pl-6 pr-2 pt-[4px] pb-[5px] text-[12px] font-medium leading-none tabular-nums overflow-hidden whitespace-nowrap text-[var(--t2)]"
        style={{ fontFamily: 'var(--font-body)', fontVariantNumeric: 'tabular-nums' }}
        title={fullText}
      >
        {segs.map((s, i) => {
          const prev = segs[i - 1]
          const sepTitle = s.title || fullText
          // Fertig: der erste Trenner direkt nach der Zeit ist der Abschluss-
          // Haken, ruhig und hell wie der Rest, nicht mehr terracotta. Während
          // der Arbeit (und zwischen weiteren Aktionen) steht dort ein Punkt.
          const checkSep = !busy && prev && prev.type === 'time'
          return (
            <Fragment key={i}>
              {i > 0 ? (
                checkSep
                  ? <span title="Fertig" aria-label="Fertig" style={{ display: 'inline-flex', alignItems: 'center', padding: '0 0.4em', color: 'var(--t1)' }}><Check size={12} strokeWidth={2.4} /></span>
                  : <span title={sepTitle} aria-label={sepTitle} style={{ color: 'var(--t2)', padding: '0 0.5em', fontSize: '1.05em', lineHeight: 1 }}>•</span>
              ) : null}
              {s.node}
            </Fragment>
          )
        })}
        {/* Stand nur die Zeit da (kein weiteres Segment), hängt der Haken hinten
            an, damit jeder fertige Lauf mit einem Haken endet. */}
        {!busy && segs.length > 0 && segs[segs.length - 1].type === 'time' ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', paddingLeft: '0.4em', color: 'var(--t1)' }}><Check size={12} strokeWidth={2.4} /></span>
        ) : null}
      </div>
      {busy && (
        <div className="flex h-[var(--header-row-h)] items-center pl-1 pr-6">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onStop() }}
            className="inline-flex h-6 w-6 items-center justify-center text-[var(--t3)] opacity-0 group-hover:opacity-100 hover:!text-red-400 transition-all cursor-pointer"
            title="Agent stoppen"
            aria-label="Agent stoppen"
          >
            <Square className="w-3 h-3" fill="currentColor" strokeWidth={0} />
          </button>
        </div>
      )}
      {queueOpen && queueLength > 0 && (
        <>
          {/* Klick-Faenger: Tap irgendwohin schliesst das Popover wieder. */}
          <div className="fixed inset-0 z-40" onClick={() => setQueueOpen(false)} />
          <div
            className="queue-popover absolute bottom-full left-4 z-50 mb-2 w-[300px] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--border-f)] bg-[var(--bg-2)]/95 p-1.5 backdrop-blur-md animate-[fadeIn_0.12s_ease]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-2 pt-1 pb-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--t3)]">In Warteschlange</span>
              <button
                type="button"
                onClick={() => onClearQueue()}
                className="text-[11px] font-medium text-[var(--t3)] hover:text-red-400 transition-colors cursor-pointer"
              >
                Alle verwerfen
              </button>
            </div>
            <div className="flex flex-col gap-0.5 max-h-[40vh] overflow-y-auto">
              {queueItems.map((item, idx) => (
                <div key={item.id} className="group/q flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--bg-3)] transition-colors">
                  <span className="w-4 flex-shrink-0 text-center text-[12px] font-medium text-[var(--t3)]">{idx + 1}</span>
                  <span className="flex-1 truncate text-[13px] text-[var(--t2)]">{item.text}</span>
                  <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 group-hover/q:opacity-100 transition-opacity">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => onMoveQueueItem(item.id, -1)}
                      className="p-0.5 text-[var(--t3)] hover:text-[var(--t1)] disabled:opacity-30 disabled:hover:text-[var(--t3)] transition-colors cursor-pointer disabled:cursor-default"
                      title="Nach oben"
                      aria-label="Nach oben"
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === queueItems.length - 1}
                      onClick={() => onMoveQueueItem(item.id, 1)}
                      className="p-0.5 text-[var(--t3)] hover:text-[var(--t1)] disabled:opacity-30 disabled:hover:text-[var(--t3)] transition-colors cursor-pointer disabled:cursor-default"
                      title="Nach unten"
                      aria-label="Nach unten"
                    >
                      <ChevronDownIcon className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveQueueItem(item.id)}
                      className="p-0.5 text-[var(--t3)] hover:text-red-400 transition-colors cursor-pointer"
                      title="Diesen Eintrag verwerfen"
                      aria-label="Diesen Eintrag verwerfen"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// Dedupe fuer den Server-zurueck-Resume ueber Pane-Instanzen hinweg: pro
// Restart-Broadcast (eventId) darf jede convId nur einmal mit "Server ist wieder
// da." fortfuehren, auch wenn zwei Panes dieselbe Conversation offen haben.
const _serverBackSeen = new Set<string>()

export function ChatPane({ defaultAgent = 'main', conversationId: externalConvId, paneIndex = 0, composerStorageKey = 'deck:composerCollapsed', onOpenRef, onAgentFocus, onConversationChange, onAgentSwitch, mobile, mobileConversations, mobileArchivedChats, mobileProjects, mobileUnread, mobileBusyConvs, mobileBusyStartedAt, onMobileConvChange, onMobileNewChat, onMobileRenameChat, onMobileArchiveChat, onMobileRestoreChat, onMobileLoadArchive, onStartVoice, voiceReady, isActive = true, mobileSlotIndicator, paneSwitcher, infoPaneOpen = false }: { defaultAgent?: string; conversationId?: string; paneIndex?: number; composerStorageKey?: string; onOpenRef?: (path: string) => void; onAgentFocus?: (agent: string) => void; onConversationChange?: (convId: string) => void; onAgentSwitch?: (agent: string) => void; mobile?: boolean; mobileConversations?: MobileChatConv[]; mobileArchivedChats?: MobileChatConv[]; mobileProjects?: MobileChatProject[]; mobileUnread?: Set<string>; mobileBusyConvs?: Set<string>; mobileBusyStartedAt?: Map<string, number>; onMobileConvChange?: (convId: string, agent: string) => void; onMobileNewChat?: (agent: string, project?: string) => void; onMobileRenameChat?: (convId: string, title: string) => void; onMobileArchiveChat?: (convId: string) => void; onMobileRestoreChat?: (convId: string) => void; onMobileLoadArchive?: () => void; onStartVoice?: (convId: string, agent: string) => void; voiceReady?: boolean; isActive?: boolean; mobileSlotIndicator?: ReactNode; paneSwitcher?: ReactNode; infoPaneOpen?: boolean }) {
  const effectiveChannelId = `channel-${defaultAgent}`

  const [agent, setAgent] = useState(defaultAgent)
  const [project, setProject] = useState('')
  const [convIdState, setConversationId] = useState('')
  // Desktop hat keinen vollen Composer mehr: unten liegt der feste Futter-Bereich,
  // die Eingabe lebt nur noch in der dezenten schwebenden Pille. Darum immer
  // eingeklappt (mobile behält seinen eigenen Composer).
  const [composerCollapsed, setComposerCollapsed] = useState<boolean>(() => !mobile)
  const [miniComposerOpen, setMiniComposerOpen] = useState(false)
  const [miniComposerText, setMiniComposerText] = useState('')
  const miniComposerInputRef = useRef<HTMLInputElement>(null)
  const miniComposerFileInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (mobile) return
    try { localStorage.setItem(composerStorageKey, composerCollapsed ? '1' : '0') } catch {}
  }, [composerCollapsed, mobile, composerStorageKey])
  useEffect(() => {
    if (!miniComposerOpen) return
    const t = window.setTimeout(() => miniComposerInputRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [miniComposerOpen])
  const [engine, setEngine] = useState<Engine>(() => getDefaultEngine())
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [messages, setMessages] = useState<Message[]>([])
  const [scrollTrigger, setScrollTrigger] = useState(0)
  const [layoutTrigger, setLayoutTrigger] = useState(0)
  const [, setIndicatorVisible] = useState(true)
  const [loaded, setLoaded] = useState('')
  const [model, setModel] = useState(() => defaultModelForEngine(getDefaultEngine()))
  const [thinkingText, setThinkingText] = useState('')
  const [phaseLabel, setPhaseLabel] = useState('')
  const [activeTools, setActiveTools] = useState<ToolCall[]>([])
  const [werkbankTasks, setWerkbankTasks] = useState<WerkbankFooterTask[]>([])
  const [, setWerkbankTick] = useState(0)
  const [disconnected, setDisconnected] = useState(false)
  const [visualFinalizeKey, setVisualFinalizeKey] = useState<string | null>(null)
  const [visualFinalizeToken, setVisualFinalizeToken] = useState<number>(0)
  const hubRef = useRef<WsHubHandle | null>(null)
  const busyRef = useRef(false)
  const historyRef = useRef<{ role: string; content: string }[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const msgAddedRef = useRef(false)
  const fullTextRef = useRef('')
  const messagesRef = useRef<Message[]>([])
  const completedStreamAtRef = useRef<Record<string, number>>({})
  const convIdRef = useRef('')
  const messagesConvIdRef = useRef('')
  const historyLoadSeqRef = useRef(0)
  const streamStateInFlightRef = useRef(false)
  const autoResumeAttemptedRef = useRef<Set<number>>(new Set())
  const autoResumeRecheckedRef = useRef<Set<number>>(new Set())
  const pendingVisualDoneRef = useRef<PendingVisualDone | null>(null)

  useEffect(() => {
    if (!werkbankTasks.some(t => t.status === 'running' || t.status === 'queued')) return
    const id = window.setInterval(() => setWerkbankTick(t => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [werkbankTasks])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const isStaleStreamForCurrentMessages = useCallback((startedAt?: number) => {
    if (!startedAt || startedAt <= 0) return false
    const lastBot = [...messagesRef.current].reverse().find(m => m.bot)
    if (!lastBot || lastBot.incomplete || !lastBot.ts) return false
    return lastBot.ts * 1000 >= startedAt - 1000
  }, [])

  const isRecentlyCompletedStream = useCallback((cid: string, startedAt?: number) => {
    const completedAt = completedStreamAtRef.current[cid] || 0
    if (!completedAt || Date.now() - completedAt > 30_000) return false
    if (!startedAt || startedAt <= 0) return true
    return startedAt <= completedAt + 1000
  }, [])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      if ((detail.paneIndex ?? 0) !== paneIndex) return
      setLayoutTrigger(t => t + 1)
    }
    window.addEventListener('deck:composerLayout', handler)
    return () => window.removeEventListener('deck:composerLayout', handler)
  }, [paneIndex])
  // Separate ref for tracking prop-driven conv changes; convIdRef gets updated
  // synchronously by the deck:loadConversation listener, so we can't use it here.
  const lastExternalConvRef = useRef('')

  // Sync agent when parent changes it
  useEffect(() => { setAgent(defaultAgent); setLoaded('') }, [defaultAgent])
  // Sync conversation when parent passes a different one
  useEffect(() => {
    if (externalConvId && externalConvId !== lastExternalConvRef.current) {
      chatTrace('chat.switch.external', { conversationId: externalConvId, paneIndex, mobile: !!mobile })
      lastExternalConvRef.current = externalConvId
      setLoaded('')
      // Switching chats: reset local streaming state. If the new chat is still running
      // in the background, restore busy from the global busyConvs set and rebase the
      // elapsed timer from busyStartedAt so it stays in sync with the slot pill.
      stopTimer()
      setElapsed(0)
      setThinkingText('')
      setPhaseLabel('')
      setActiveTools([])
      messagesConvIdRef.current = ''
      const cached = getChatHistoryCache(externalConvId)
      if (cached) {
        setMessages(cached.messages)
        messagesConvIdRef.current = externalConvId
        historyRef.current = cached.history
      } else {
        setMessages([])
        historyRef.current = []
      }
      pendingVisualDoneRef.current = null
      setVisualFinalizeKey(null)
      setVisualFinalizeToken(0)
      const isBusyNow = !!(mobileBusyConvs && mobileBusyConvs.has(externalConvId))
      setBusy(isBusyNow)
      if (isBusyNow && mobileBusyStartedAt) {
        const startedAt = mobileBusyStartedAt.get(externalConvId)
        if (startedAt) {
          const startSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
          startTimer(startSec)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalConvId])

  const cfg = AGENTS[agent] || AGENTS['main']
  const currentConversationId = externalConvId || convIdState

  // Engine aus der DB fuer den aktuellen Chat nachziehen. Leere Chats behalten den
  // localStorage-Default (= letzte Wahl), damit neu erstellte Chats erwartungsgemaess starten.
  useEffect(() => {
    const cid = currentConversationId
    if (!cid || cid.startsWith('channel-')) return
    fetch(`/api/conversations?limit=200&archived=true`)
      .then(r => r.json())
      .then(data => {
        const c = (data.conversations || []).find((x: any) => x.id === cid)
        if (c?.engine === 'claude' || c?.engine === 'codex') {
          setEngine(c.engine)
          setModel(normalizeModelForEngine(c.engine, c.model))
        }
      })
      .catch(() => {})
  }, [currentConversationId])

  useEffect(() => {
    const cid = currentConversationId
    if (!cid || cid.startsWith('channel-')) {
      setWerkbankTasks([])
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/loops/werkbank?limit=80', { cache: 'no-store' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || cancelled) return
        const tasks = Array.isArray(data.tasks) ? data.tasks : []
        const ownTasks = tasks
          .filter((task: WerkbankFooterTask) => task?.origin?.conversation_id === cid)
          .filter((task: WerkbankFooterTask) => {
            const status = String(task?.status || '')
            if (['running', 'queued', 'needs_input', 'needs_work', 'blocked', 'rate_limited'].includes(status)) return true
            // Fertige Auftraege bleiben 10 Minuten als ruhiger Haken sichtbar, dann raus.
            return status === 'done' && (Date.now() / 1000 - Number(task?.updated_at || 0)) < 600
          })
          .sort((a: WerkbankFooterTask, b: WerkbankFooterTask) => (b.updated_at || 0) - (a.updated_at || 0))
        setWerkbankTasks(ownTasks)
      } catch {
        if (!cancelled) setWerkbankTasks([])
      }
    }
    load()
    const interval = window.setInterval(load, 6000)
    window.addEventListener('deck:sync', load as EventListener)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('deck:sync', load as EventListener)
    }
  }, [currentConversationId])

  // Bewusster Werkbank-Spawn aus dem Composer (Plus-Menue "An Werkbank uebergeben").
  // Das Event ist global; nur der Pane mit passendem paneIndex reagiert, sonst
  // wuerden bei mehreren offenen Panes mehrere Spawns gleichzeitig feuern.
  useEffect(() => {
    const onSpawn = async (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      if (detail.paneIndex !== paneIndex) return
      const brief = String(detail.brief || '').trim()
      const cid = currentConversationId
      if (!brief || !cid || cid.startsWith('channel-')) return
      try {
        const res = await fetch('/api/loops/werkbank/spawn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: cid, brief, agentId: agent, project }),
        })
        if (res.ok) window.dispatchEvent(new CustomEvent('deck:sync'))
      } catch {
        // still: Composer hat den Text schon geleert, Fehler bleibt geraeuschlos
      }
    }
    window.addEventListener('deck:werkbankSpawn', onSpawn as EventListener)
    return () => window.removeEventListener('deck:werkbankSpawn', onSpawn as EventListener)
  }, [currentConversationId, agent, project, paneIndex])

  // Engine-Auswahl ist UI-seitig entfernt. Der Wert bleibt nur noch als
  // Conversation-Attribut, das Backend liest ihn aus der DB.

  // Re-fetch messages from DB for current conversation
  const restoreCachedHistory = useCallback((cid: string, limit = 100, opts?: { mergeLive?: boolean; scroll?: boolean }): boolean => {
    if (!cid || cid !== convIdRef.current) return false
    const cached = getChatHistoryCache(cid, limit)
    if (!cached) {
      chatTrace('history.cache.miss', { conversationId: cid, limit, paneIndex, mobile: !!mobile })
      return false
    }
    const canMergeLive = !!opts?.mergeLive && messagesConvIdRef.current === cid
    chatTrace('history.cache.restore', {
      conversationId: cid,
      limit,
      messages: cached.messages.length,
      mergeLive: canMergeLive,
      scroll: !!opts?.scroll,
      ageMs: Date.now() - cached.fetchedAt,
      paneIndex,
      mobile: !!mobile,
    })
    setMessages(prev => canMergeLive ? mergeLiveTools(prev, cached.messages) : cached.messages)
    messagesConvIdRef.current = cid
    historyRef.current = cached.history
    if (opts?.scroll) setScrollTrigger(t => t + 1)
    return true
  }, [mobile, paneIndex])

  const showCachedOrEmpty = useCallback((cid: string, limit = 100) => {
    chatTrace('chat.show.cached-or-empty', { conversationId: cid, limit, paneIndex, mobile: !!mobile })
    messagesConvIdRef.current = ''
    if (!restoreCachedHistory(cid, limit)) {
      // Bewusst KEIN localStorage-Erstpaint mehr: Christian will beim Neuladen nur
      // den echten Ist-Stand vom Server sehen, nie eine alte gespeicherte Kopie, die
      // kurz aufblitzt. Die lokale Kopie bleibt reiner Notnagel und wird erst in der
      // loadHistory-Fehlerbehandlung gezogen, falls der Server nicht antwortet
      // (Restart). Frisches In-Memory (restoreCachedHistory) zählt nicht als "alt".
      {
        chatTrace('chat.show.empty-before-db', { conversationId: cid, limit, paneIndex, mobile: !!mobile })
        setMessages([])
        historyRef.current = []
      }
    }
  }, [mobile, paneIndex, restoreCachedHistory])

  const applyHistoryData = useCallback((cid: string, data: any, opts?: { mergeLive?: boolean; scroll?: boolean; limit?: number }): Message[] | null => {
    if (!cid || cid !== convIdRef.current) return null
    const msgs: Message[] = (data.messages || [])
      .filter((m: any) => m.content || m.incomplete)
      .map(mapMsg)
    const canMergeLive = !!opts?.mergeLive && messagesConvIdRef.current === cid
    chatTrace('history.apply', {
      conversationId: cid,
      messages: msgs.length,
      mergeLive: canMergeLive,
      scroll: !!opts?.scroll,
      paneIndex,
      mobile: !!mobile,
    })
    setMessages(prev => canMergeLive ? mergeLiveTools(prev, msgs) : msgs)
    messagesConvIdRef.current = cid
    if (opts?.scroll) setScrollTrigger(t => t + 1)
    historyRef.current = historyFromMessages(msgs)
    updateChatHistoryCache(cid, msgs, opts?.limit ?? 100)
    return msgs
  }, [mobile, paneIndex])

  const loadHistory = useCallback((cid: string, limit = 100, opts?: { mergeLive?: boolean; scroll?: boolean; force?: boolean }): Promise<Message[] | null> => {
    if (!cid) return Promise.resolve(null)
    const cached = getChatHistoryCache(cid, limit)
    if (!opts?.force && cached && Date.now() - cached.fetchedAt < CHAT_HISTORY_REFETCH_COOLDOWN_MS) {
      chatTrace('history.cache.hit', {
        conversationId: cid,
        limit,
        messages: cached.messages.length,
        scroll: !!opts?.scroll,
        ageMs: Date.now() - cached.fetchedAt,
        paneIndex,
        mobile: !!mobile,
      })
      if (opts?.scroll) setScrollTrigger(t => t + 1)
      return Promise.resolve(cached.messages)
    }
    chatTrace('history.load.fetch', {
      conversationId: cid,
      limit,
      force: !!opts?.force,
      scroll: !!opts?.scroll,
      paneIndex,
      mobile: !!mobile,
    })
    return fetchHistoryData(cid, limit)
      .then(data => applyHistoryData(cid, data, { mergeLive: opts?.mergeLive, scroll: opts?.scroll, limit }))
      .catch(() => {
        // Notnagel: Server nicht erreichbar (z. B. Restart). Nur wenn fuer diesen
        // Chat noch nichts Echtes geladen wurde, die lokale Kopie zeigen, damit der
        // Verlauf nicht leer bleibt. Sobald der Server wieder da ist, ersetzt der
        // naechste loadHistory die Kopie durch den echten Stand.
        if (cid === convIdRef.current && messagesConvIdRef.current !== cid) {
          const localMessages = readLocalChatMessages(cid)
          if (localMessages.length > 0) {
            chatTrace('history.local.fallback', { conversationId: cid, limit, messages: localMessages.length, paneIndex, mobile: !!mobile })
            setMessages(localMessages)
            messagesConvIdRef.current = cid
            historyRef.current = historyFromMessages(localMessages)
            if (opts?.scroll) setScrollTrigger(t => t + 1)
          }
        }
        return null
      })
  }, [applyHistoryData, mobile, paneIndex])

  const refreshMessages = useCallback((opts?: { scroll?: boolean }) => {
    const cid = convIdRef.current
    if (!cid) return
    void loadHistory(cid, 100, { mergeLive: true, scroll: opts?.scroll ?? true, force: true })
  }, [loadHistory])

  // Timer
  const startTimer = useCallback((startSec: number = 0) => {
    setElapsed(startSec)
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    const startedAtMs = Date.now() - startSec * 1000
    timerRef.current = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)))
    }, 1000)
  }, [])

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  const notifyConversationBusy = useCallback((cid: string, isBusy: boolean, opts?: { startedAt?: number; done?: boolean }) => {
    if (!cid) return
    window.dispatchEvent(new CustomEvent('deck:convBusy', {
      detail: {
        conversationId: cid,
        busy: isBusy,
        done: opts?.done,
        startedAt: opts?.startedAt,
      },
    }))
  }, [])

  useEffect(() => {
    if (!mobile || !externalConvId) return
    const isBusyNow = !!(mobileBusyConvs && mobileBusyConvs.has(externalConvId))
    if (isBusyNow) {
      setBusy(true)
      const startedAt = mobileBusyStartedAt?.get(externalConvId)
      if (startedAt) {
        const startSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
        startTimer(startSec)
      }
      return
    }
    if (busyRef.current) {
      stopTimer()
      setBusy(false)
      setThinkingText('')
      setPhaseLabel('')
      setActiveTools([])
      pendingVisualDoneRef.current = null
      setVisualFinalizeKey(null)
      setVisualFinalizeToken(0)
      refreshMessages()
    }
  }, [externalConvId, mobile, mobileBusyConvs, mobileBusyStartedAt, refreshMessages, startTimer, stopTimer])

  // Mobile-Sicherheitsnetz gegen die "fertige Antwort erscheint erst nach
  // meinem naechsten Send"-Luecke: Ist die aktive Unterhaltung nicht (mehr)
  // busy, aber die letzte sichtbare Nachricht stammt vom Nutzer, fehlt die
  // Bot-Antwort. Das passiert, wenn die Pane den kurzen Busy-Push verpasst hat
  // (Lauf zu schnell fuers 8s-Polling, oder Push verschluckt) und der done-
  // Refresh nie feuerte. Wir laden dann verzoegert aus der DB nach. Selbst-
  // begrenzend: sobald die Bot-Bubble da ist, ist die letzte Nachricht bot.
  // Ein Versuchszaehler pro Conv deckelt den Nachlauf, falls (z.B. bei einem
  // stillen Fehler) gar keine Antwort kommt.
  const mobileTailRetryRef = useRef<Record<string, number>>({})
  useEffect(() => {
    if (!mobile || !externalConvId) return
    const cid = externalConvId
    if (mobileBusyConvs && mobileBusyConvs.has(cid)) return
    if (busy) return
    const last = messages[messages.length - 1]
    if (!last) return
    if (last.bot || last.author === 'System') {
      // Antwort ist da — Zaehler fuer diese Conv zuruecksetzen.
      if (mobileTailRetryRef.current[cid]) delete mobileTailRetryRef.current[cid]
      return
    }
    const tries = mobileTailRetryRef.current[cid] || 0
    if (tries >= 5) return
    const t = setTimeout(() => {
      mobileTailRetryRef.current[cid] = tries + 1
      refreshMessages({ scroll: false })
    }, 800)
    return () => clearTimeout(t)
  }, [mobile, externalConvId, mobileBusyConvs, busy, messages, refreshMessages])

  const finalizeVisualDone = useCallback((done: PendingVisualDone) => {
    chatTrace('visual.done.finalize', {
      conversationId: done.conversationId || convIdRef.current,
      paneIndex,
      mobile: !!mobile,
      status: done.status,
      textLen: done.responseText.length,
    })
    if (done.status !== 'error' && (typeof document === 'undefined' || document.hasFocus())) {
      playUISound(done.didWork ? 'level-up' : 'message-in', done.didWork ? 0.3 : 0.25)
    }
    stopTimer()
    setBusy(false)
    setThinkingText('')
    setPhaseLabel('')
    setActiveTools([])
    msgAddedRef.current = false
    fullTextRef.current = ''
    pendingVisualDoneRef.current = null
    setVisualFinalizeKey(null)
    setVisualFinalizeToken(0)
    if (done.conversationId) notifyConversationBusy(done.conversationId, false, { done: true })
    refreshMessages({ scroll: false })
    if (done.conversationId && done.status !== 'error') {
      window.dispatchEvent(new CustomEvent('chat:turn-complete', {
        detail: { conversationId: done.conversationId },
      }))
      // Selbst erzeugte HTML-Artefakte sofort im Workspace-Preview zeigen,
      // sobald der Turn fertig ist — Christian muss den Link nicht erst klicken.
      // Nur Desktop: auf Mobile würde ein Vollbild-Overlay den Chat verdecken.
      if (!mobile) {
        const matches = done.responseText.match(/\bwork\/artifacts\/\d{4}-\d{2}-\d{2}-[^\s)"'<>]+\.html\b/g)
        if (matches && matches.length) {
          window.dispatchEvent(new CustomEvent('deck:openFile', {
            detail: { path: matches[matches.length - 1] },
          }))
        }
      }
    }
  }, [mobile, notifyConversationBusy, paneIndex, refreshMessages, stopTimer])

  const handleVisualComplete = useCallback((messageKey: string) => {
    const pending = pendingVisualDoneRef.current
    if (!pending || pending.messageKey !== messageKey) return
    finalizeVisualDone(pending)
  }, [finalizeVisualDone])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  const syncActiveStreamState = useCallback(async (opts?: { attach?: boolean; clearIfIdle?: boolean }) => {
    const cid = convIdRef.current
    if (!cid) return false
    // Backend-Stream ist fertig, aber die Schreibmaschine deckt die Antwort noch
    // lesegetaktet auf. Dann ist der Lauf aus Nutzersicht NICHT idle: busy muss
    // stehen bleiben, sonst räumt der Watchdog ihn ab und der Queue-Dispatch
    // feuert mitten in die noch laufende Ausgabe (postet die nächste Nachricht zu
    // früh). handleVisualComplete schliesst den Lauf ab, sobald der Reveal durch ist.
    // Zombie-Schutz: Verschluckt der Reveal sein Schluss-Event (onVisualComplete
    // feuert nie, z.B. nach Unmount/Token-Mismatch), bliebe dieser Marker fuer
    // immer gesetzt — busy haengt, der Watchdog pollt ewig und raeumt nie auf.
    // Nach einem harten Zeitlimit schliessen wir den Lauf darum selbst ab.
    if (pendingVisualDoneRef.current) {
      const stuck = pendingVisualDoneRef.current
      if (Date.now() - (stuck.token || 0) < 60000) return true
      finalizeVisualDone(stuck)
      return false
    }
    if (streamStateInFlightRef.current) return false
    streamStateInFlightRef.current = true
    chatTrace('stream.state.check', {
      conversationId: cid,
      attach: opts?.attach !== false,
      clearIfIdle: !!opts?.clearIfIdle,
      paneIndex,
      mobile: !!mobile,
    })
    try {
      const res = await fetch('/api/active-streams')
      const data = await res.json()
      const streams: Array<{ convId: string; startedAt: number }> = Array.isArray(data?.streams) ? data.streams : []
      const active = streams.find(s => s.convId === cid)
      if (active) {
        if (isStaleStreamForCurrentMessages(active.startedAt) || isRecentlyCompletedStream(cid, active.startedAt)) {
          chatTrace('stream.state.stale-ignore', {
            conversationId: cid,
            startedAt: active.startedAt,
            recentlyCompleted: isRecentlyCompletedStream(cid, active.startedAt),
            paneIndex,
            mobile: !!mobile,
          })
          stopTimer()
          setBusy(false)
          setThinkingText('')
          setPhaseLabel('')
          setActiveTools([])
          pendingVisualDoneRef.current = null
          setVisualFinalizeKey(null)
          setVisualFinalizeToken(0)
          notifyConversationBusy(cid, false, { done: true })
          return false
        }
        chatTrace('stream.state.active', {
          conversationId: cid,
          startedAt: active.startedAt,
          paneIndex,
          mobile: !!mobile,
        })
        setBusy(true)
        notifyConversationBusy(cid, true, { startedAt: active.startedAt })
        if (active.startedAt && active.startedAt > 0) {
          const startSec = Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000))
          startTimer(startSec)
        }
        if (opts?.attach !== false && hubRef.current?.isOpen()) {
          hubRef.current.send(JSON.stringify({ action: 'attach', conversationId: cid }))
        }
        return true
      }
      if (opts?.clearIfIdle) {
        chatTrace('stream.state.idle-clear', { conversationId: cid, paneIndex, mobile: !!mobile })
        stopTimer()
        setBusy(false)
        setThinkingText('')
        setPhaseLabel('')
        setActiveTools([])
        pendingVisualDoneRef.current = null
        setVisualFinalizeKey(null)
        setVisualFinalizeToken(0)
        notifyConversationBusy(cid, false, { done: true })
        refreshMessages()
      }
    } catch {
      chatTrace('stream.state.error', { conversationId: cid, paneIndex, mobile: !!mobile })
      if (opts?.clearIfIdle) refreshMessages()
    } finally {
      streamStateInFlightRef.current = false
    }
    return false
  }, [finalizeVisualDone, isRecentlyCompletedStream, isStaleStreamForCurrentMessages, mobile, notifyConversationBusy, paneIndex, refreshMessages, startTimer, stopTimer])

  // (Frühere localStorage-basierte "Leader-Election" entfernt — sie war nie
  // aktiv und der wsHub bündelt jetzt echt auf einen Socket pro Tab.)

  // Geteilter WebSocket pro Tab (siehe lib/wsHub.ts). Statt eines eigenen
  // Sockets je Pane meldet sich jede Pane beim Hub an. Der Hub multiplext die
  // Events an alle Panes und übernimmt Reconnect + Outbox zentral. Die
  // Event-Filterung nach conversationId bleibt unverändert in handleWsMessage.
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hubEverOpenRef = useRef(false)
  const wasVisiblyDisconnectedRef = useRef(false)
  // Stabile Indirektion: der Hub ruft immer die aktuelle Handler-Version über
  // diese Refs auf, sodass sich der Message-Handler nie neu binden muss (vorher
  // wurde er bei jedem Token neu gebunden, weil `messages` in den Deps hing).
  const handleWsMessageRef = useRef<(msg: any) => void>(() => {})
  const onWsOpenRef = useRef<() => void>(() => {})
  const onWsCloseRef = useRef<() => void>(() => {})

  const onWsOpen = useCallback(() => {
    setDisconnected(false)
    if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null }
    const cid = convIdRef.current
    if (cid && hubRef.current) {
      hubRef.current.send(JSON.stringify({ action: 'attach', conversationId: cid }))
    }
    const reconnected = hubEverOpenRef.current
    hubEverOpenRef.current = true
    // Erstverbindung: kein clearIfIdle (ein frischer Send ist evtl. noch nicht
    // als Stream registriert). Reconnect: busy zurücksetzen, falls das Backend
    // inzwischen fertig ist — sonst hängt der Timer ewig.
    void syncActiveStreamState({ attach: false, clearIfIdle: reconnected })
    refreshMessages()
    if (reconnected) {
      // Während des Drops evtl. verpasste Nachrichten nachladen.
      setTimeout(() => refreshMessages(), 5000)
      // Nur quittieren, wenn der User den Disconnect-Banner tatsächlich sah.
      if (wasVisiblyDisconnectedRef.current) {
        wasVisiblyDisconnectedRef.current = false
        setMessages(prev => [...prev, {
          author: 'System',
          content: 'Verbindung wiederhergestellt.',
          ts: Date.now() / 1000,
        }])
        setScrollTrigger(t => t + 1)
      }
    }
  }, [refreshMessages, syncActiveStreamState])

  const onWsClose = useCallback(() => {
    if (mobile && !isActiveRef.current) { setDisconnected(false); return }
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current)
    // Banner erst nach 10s: iOS PWA braucht nach Foreground oft 3–5s bis WS wieder offen.
    bannerTimerRef.current = setTimeout(() => {
      setDisconnected(true)
      wasVisiblyDisconnectedRef.current = true
    }, 10000)
    // Laufende Streams nicht lokal beenden — Watchdog/Reconnect zieht den echten Stand nach.
    if (busyRef.current) void syncActiveStreamState({ attach: false, clearIfIdle: false })
  }, [mobile, syncActiveStreamState])

  onWsOpenRef.current = onWsOpen
  onWsCloseRef.current = onWsClose


  // Beim Hub anmelden (idempotent) und das Handle behalten. Stabile Deps, da
  // der Hub die Handler über die Refs oben aufruft.
  const acquireHub = useCallback((): WsHubHandle => {
    if (hubRef.current) return hubRef.current
    const handle = acquireWsHub({
      onMessage: (m) => handleWsMessageRef.current(m),
      onOpen: () => onWsOpenRef.current(),
      onClose: () => onWsCloseRef.current(),
    })
    hubRef.current = handle
    return handle
  }, [])

  // Senden über den Hub. Stellt sicher, dass ein Handle existiert (acquire on
  // demand); die Outbox im Hub puffert, falls der Socket gerade nicht offen ist.
  const hubSend = useCallback((raw: string) => {
    acquireHub().send(raw)
  }, [acquireHub])

  const handleWsMessage = useCallback((msg: any) => {
    const agentName = msg.agent || ''

    // Title updates are handled at App level — dispatch and skip
    if (msg.type === 'conv.titleUpdate') {
      window.dispatchEvent(new CustomEvent('deck:titleUpdate', { detail: { conversationId: msg.conversationId, title: msg.title } }))
      return
    }

    // Auto-Project-Zuordnung — App-Level-Update der Sidebar; Suggest dazu räumen.
    if (msg.type === 'conv.projectUpdate') {
      window.dispatchEvent(new CustomEvent('deck:projectUpdate', { detail: { conversationId: msg.conversationId, projectId: msg.projectId || '' } }))
      return
    }

    // Slot-Sync (Desktop ↔ Mobile): andere Clients haben die ersten 4 Chats
    // umgestellt. App-Level lauschen via deck:slotsUpdate. Nur Pane 0 dispatcht,
    // sonst 4× pro Event.
    if (msg.type === 'slots.update' && paneIndex === 0) {
      window.dispatchEvent(new CustomEvent('deck:slotsUpdate', { detail: { slots: msg.slots || [], activeSlot: msg.activeSlot, source: msg.source || '' } }))
      return
    }

    // Per-Chat Prefs (Effort + DeepMode) — andere Geräte ändern die Auswahl,
    // alle Panes mit derselben convId ziehen nach.
    if (msg.type === 'conv.prefsUpdate') {
      window.dispatchEvent(new CustomEvent('deck:convPrefsUpdate', {
        detail: {
          conversationId: msg.conversationId,
          effort: msg.effort,
          deepMode: msg.deepMode,
          dualMode: msg.dualMode,
          source: msg.source || '',
        },
      }))
      return
    }

    // Globale Prefs (Autoplay, TTS, Voice, Theme …) — andere Geräte schalten,
    // wir spiegeln in localStorage und feuern UI-Events. Nur Pane 0 verarbeitet,
    // sonst werden Listener mehrfach getriggert.
    if (msg.type === 'prefs.update' && paneIndex === 0) {
      import('../prefs').then(m => m.applyRemotePrefs(msg.changes || {}, msg.source))
      return
    }

    // KlausFlow Pane-PTT: ein lokal-aufgezeichnetes Transkript landet im Composer
    // von Pane N (1-basiert). Jeder ChatPane hat eine eigene WS, also nur dispatchen
    // wenn dieses Pane gemeint ist — sonst gaeben es 4 Dispatches pro Event.
    // Mobile ignoriert komplett: Pane-Layouts existieren nur am Desktop, sonst
    // schickt eine im Hintergrund laufende Mobile-App jede Pane-Eingabe doppelt.
    if (msg.type === 'pane.input' && typeof msg.pane === 'number' && msg.pane === paneIndex + 1) {
      if (mobile) return
      const text = String(msg.text || '').trim()
      if (text) window.dispatchEvent(new CustomEvent('deck:paneInput', {
        detail: { paneIndex, text, eventId: typeof msg.eventId === 'string' ? msg.eventId : '' },
      }))
      return
    }

    // KlausFlow Pane-Focus: erster PTT-Druck (Aufnahme-Start) meldet nur das
    // Ziel-Pane, damit der Desktop sofort dorthin springt — noch ohne Text.
    // Nur das gemeinte Pane dispatcht, sonst 4× pro Event. Mobile ignoriert.
    if (msg.type === 'pane.focus' && typeof msg.pane === 'number' && msg.pane === paneIndex + 1) {
      if (mobile) return
      window.dispatchEvent(new CustomEvent('deck:paneFocus', { detail: { paneIndex } }))
      return
    }

    // Agent-Mic Stop-Audio: Hardware-Taste auf Agent-Mic kappt TTS in allen Tabs.
    if (msg.type === 'voice.stop') {
      audioQueue.stopAll()
      return
    }

    // UI-Layout-Kommando vom Backend (z.B. Text-Chat-Agent pusht via /api/ui-command).
    // Jede Pane hat ihr eigenes WS, also nur paneIndex 0 dispatcht das Event,
    // sonst feuern wir 1× pro offener Pane. Mobile ignoriert.
    if (msg.type === 'ui.command' && paneIndex === 0 && !mobile) {
      const cmd = String(msg.command || '')
      const payload = msg.payload || {}
      if (cmd === 'info') window.dispatchEvent(new CustomEvent('deck:info', { detail: payload }))
      else if (cmd === 'pane') window.dispatchEvent(new CustomEvent('deck:pane', { detail: payload }))
      else if (cmd === 'info-section') window.dispatchEvent(new CustomEvent('deck:info-section', { detail: payload }))
      return
    }

    // Server ist nach einem Restart wieder da. Das Backend nennt die convIds, deren
    // Stream der Restart gekappt hat. Pane 0 dispatcht einmal, die betroffene Pane
    // synchronisiert still den Verlauf; Auto-Resume greift nur bei echter incomplete Row.
    if (msg.type === 'server.back' && paneIndex === 0) {
      const ids = Array.isArray(msg.conversationIds) ? msg.conversationIds.map(String) : []
      window.dispatchEvent(new CustomEvent('deck:serverBack', {
        detail: { conversationIds: ids, eventId: typeof msg.eventId === 'string' ? msg.eventId : '' },
      }))
      return
    }

    // Broadcast busy state for ALL conversations (not just current) so the app can
    // show which chats are still streaming in the background.
    if (
      msg.conversationId &&
      (msg.type === 'agent.start' || msg.type === 'agent.error' || (msg.type === 'agent.done' && msg.conversationId !== convIdRef.current))
    ) {
      window.dispatchEvent(new CustomEvent('deck:convBusy', {
        detail: {
          conversationId: msg.conversationId,
          busy: msg.type === 'agent.start',
          done: msg.type === 'agent.done',
          startedAt: typeof msg.startedAt === 'number' ? msg.startedAt : undefined,
        },
      }))
    }
    // Globaler Lifecycle aus _broadcast (kein Subscriber-Filter) — Slot-Pillen
    // anderer Panes ziehen ohne 8s-Polling-Lag mit.
    if (msg.type === 'stream.state' && msg.conversationId) {
      window.dispatchEvent(new CustomEvent('deck:convBusy', {
        detail: {
          conversationId: msg.conversationId,
          busy: msg.phase === 'start',
          done: msg.phase !== 'start',
          startedAt: typeof msg.startedAt === 'number' ? msg.startedAt : undefined,
        },
      }))
      return
    }

    // Filter: only process events for THIS conversation (sync events have their own logic)
    if (msg.conversationId && msg.type !== 'sync' && msg.conversationId !== convIdRef.current) {
      return
    }

    switch (msg.type) {
      case 'agent.start':
        chatTrace('ws.agent.start', {
          conversationId: msg.conversationId || convIdRef.current,
          paneIndex,
          mobile: !!mobile,
          startedAt: typeof msg.startedAt === 'number' ? msg.startedAt : undefined,
        })
        if (msg.contextTokens) setContextTokens(msg.contextTokens)
        if (msg.contextWindow) setContextWindow(msg.contextWindow)
        setRunTokenCount(0)
        setRunInputTokens(0)
        setRunOutputTokens(0)
        lastToolTextOffsetRef.current = 0
        ttsStreamOffsetRef.current = 0
        ttsStreamAnyRef.current = false
        ttsStreamCounterRef.current = 0
        // Server-seitiger Timer-Sync: nimmt Server-Startzeit als Quelle der Wahrheit,
        // damit Desktop/Mobile dieselbe Sekunde anzeigen.
        if (typeof msg.startedAt === 'number') {
          const startSec = Math.max(0, Math.floor((Date.now() - msg.startedAt) / 1000))
          setBusy(true)
          startTimer(startSec)
        }
        break

      case 'stream.snapshot': {
        // Hard-Refresh-Reattach: Backend liefert aktuellen Stand eines laufenden
        // Streams. Wir setzen busy + Tools + Tokens, damit der Live-Eindruck
        // wieder steht. Der nachfolgende Live-Stream übernimmt dann nahtlos.
        if (!msg.running) break
        const fullText = String(msg.fullText || '')
        const segments = Array.isArray(msg.segments) ? msg.segments.filter((x: unknown) => typeof x === 'string' && String(x).trim()) : []
        const tools: ToolCall[] = (msg.toolCalls || []).map((tc: any) => ({
          id: String(tc.id || ''),
          name: String(tc.name || ''),
          input: tc.input || {},
          result: tc.result || tc.output || '',
          status: tc.status || 'running',
        }))
        const runningTools = tools.filter(t => t.status === 'running')
        chatTrace('ws.stream.snapshot', {
          conversationId: msg.conversationId || convIdRef.current,
          paneIndex,
          mobile: !!mobile,
          running: !!msg.running,
          textLen: fullText.length,
          tools: tools.length,
        })
        if (msg.contextTokens) {
          setContextTokens(msg.contextTokens)
        }
        setRunTokenCount(tokenTotalFromUsage(msg))
        if (msg.contextWindow) setContextWindow(msg.contextWindow)
        if (typeof msg.inputTokens === 'number') setRunInputTokens(visibleTokenPart(msg.inputTokens))
        if (typeof msg.outputTokens === 'number') setRunOutputTokens(visibleTokenPart(msg.outputTokens))
        if (msg.model) setModel(String(msg.model))
        const snapshotStartedAt = typeof msg.startedAt === 'number' ? msg.startedAt : 0
        const snapshotConvId = msg.conversationId || convIdRef.current
        if (isStaleStreamForCurrentMessages(snapshotStartedAt) || isRecentlyCompletedStream(snapshotConvId, snapshotStartedAt)) {
          chatTrace('ws.stream.snapshot.stale-ignore', {
            conversationId: snapshotConvId,
            startedAt: snapshotStartedAt,
            recentlyCompleted: isRecentlyCompletedStream(snapshotConvId, snapshotStartedAt),
            paneIndex,
            mobile: !!mobile,
            textLen: fullText.length,
            tools: tools.length,
          })
          stopTimer()
          setBusy(false)
          setThinkingText('')
          setPhaseLabel('')
          setActiveTools([])
          pendingVisualDoneRef.current = null
          setVisualFinalizeKey(null)
          setVisualFinalizeToken(0)
          notifyConversationBusy(snapshotConvId, false, { done: true })
          break
        }
        setBusy(true)
        const elapsedSec = snapshotStartedAt > 0
          ? Math.max(0, Math.floor((Date.now() - snapshotStartedAt) / 1000))
          : Math.max(0, Math.floor((msg.elapsedMs || 0) / 1000))
        startTimer(elapsedSec)
        setActiveTools(runningTools)
        if (msg.thinkingText) setThinkingText(String(msg.thinkingText))
        fullTextRef.current = fullText
        // Letzte Bot-Message (Partial aus DB) mit Snapshot-Stand abgleichen,
        // sodass der Live-Stream danach delta-frei weitergeht.
        setMessages(prev => {
          const arr = [...prev]
          let lastBotIdx = -1
          for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].bot) { lastBotIdx = i; break }
          }
          const buildSnapshotSteps = (text: string, toolList: ToolCall[], textSegments?: string[]): ChatStep[] => {
            const out: ChatStep[] = []
            const parts = (textSegments || []).filter(Boolean)
            if (parts.length > 0) {
              for (const part of parts) out.push({ kind: 'text', text: part })
            } else if (text) {
              out.push({ kind: 'text', text })
            }
            for (const t of toolList) out.push({ kind: 'tool', tool: t })
            return out
          }
          if (lastBotIdx >= 0) {
            const last = arr[lastBotIdx]
            const existingTools = last.tools || []
            const merged = [...existingTools]
            for (const t of tools) {
              const idx = merged.findIndex(x => x.id === t.id)
              if (idx >= 0) merged[idx] = { ...merged[idx], ...t }
              else merged.push(t)
            }
            const mergedText = fullText || last.content || ''
            arr[lastBotIdx] = {
              ...last,
              content: mergedText,
              tools: merged,
              segments: segments.length ? segments : last.segments,
              steps: buildSnapshotSteps(mergedText, merged, segments.length ? segments : last.segments),
            }
            // Reveal-State auf den Snapshot-Stand setzen, damit beim Mount
            // nicht der ganze bisherige Text neu animiert wird.
            if (last.ts) markTypewriterRead(last.ts, mergedText.length)
            msgAddedRef.current = true
          } else if (fullText || tools.length) {
            const ts = Date.now() / 1000
            arr.push({
              author: msg.agent || 'Agent',
              content: fullText,
              bot: true,
              ts,
              tools,
              segments: segments.length ? segments : undefined,
              steps: buildSnapshotSteps(fullText, tools, segments),
            })
            if (fullText) markTypewriterRead(ts, fullText.length)
            msgAddedRef.current = true
          }
          return arr
        })
        // Sound/TTS unterdrücken — wir hängen mitten in einem Stream rein.
        ttsStreamOffsetRef.current = fullText.length
        lastToolTextOffsetRef.current = fullText.length
        // Andere Panes/Tabs informieren, dass dieser Chat busy ist.
        if (msg.conversationId) {
          window.dispatchEvent(new CustomEvent('deck:convBusy', {
            detail: {
              conversationId: msg.conversationId,
              busy: true,
              startedAt: typeof msg.startedAt === 'number' ? msg.startedAt : undefined,
            },
          }))
        }
        break
      }

      case 'agent.usage':
        if (msg.contextTokens) {
          setContextTokens(msg.contextTokens)
        }
        setRunTokenCount(tokenTotalFromUsage(msg))
        if (msg.contextWindow) setContextWindow(msg.contextWindow)
        if (typeof msg.inputTokens === 'number') setRunInputTokens(visibleTokenPart(msg.inputTokens))
        if (typeof msg.outputTokens === 'number') setRunOutputTokens(visibleTokenPart(msg.outputTokens))
        break

      case 'agent.phase': {
        // Two-Pass: Backend signalisiert "Zweitblick einholen" oder "Antwort finalisieren".
        // Wir blenden das als kleinen Status oberhalb der Tools ein, sonst keine UI-Eingriffe.
        const label = typeof msg.label === 'string' ? msg.label : ''
        setPhaseLabel(label)
        break
      }

      case 'agent.text': {
        const full = msg.full || ''
        const delta = typeof msg.delta === 'string' ? msg.delta : ''
        const segments = Array.isArray(msg.segments) ? msg.segments.filter((x: unknown) => typeof x === 'string' && String(x).trim()) : []
        fullTextRef.current = full
        // Sobald echter Text fliesst, ist die Phase-Anzeige obsolet.
        if (phaseLabel) setPhaseLabel('')
        setMessages(prev => {
          const arr = [...prev]
          const last = arr.length ? arr[arr.length - 1] : null
          const addToSteps = (steps: ChatStep[] | undefined): ChatStep[] => {
            const cur = steps ? [...steps] : []
            const lastStep = cur[cur.length - 1]
            const piece = segments.length > 0 ? segments[segments.length - 1] : (delta || full)
            if (!piece) return cur
            if (segments.length > 1) {
              cur.push({ kind: 'text', text: piece })
            } else if (lastStep && lastStep.kind === 'text') {
              cur[cur.length - 1] = { kind: 'text', text: lastStep.text + piece }
            } else {
              cur.push({ kind: 'text', text: piece })
            }
            return cur
          }
          if (last && last.bot) {
            arr[arr.length - 1] = { ...last, content: full, segments: segments.length ? segments : last.segments, steps: addToSteps(last.steps) }
          } else {
            arr.push({
              author: agentName,
              content: full,
              bot: true,
              ts: Date.now() / 1000,
              tools: [],
              thinking: '',
              segments: segments.length ? segments : undefined,
              steps: [{ kind: 'text', text: segments.length > 0 ? segments[segments.length - 1] : (delta || full) }],
            })
          }
          return arr
        })
        msgAddedRef.current = true
        flushSentenceTTSRef.current(agentName, Date.now() / 1000, false)
        break
      }

      case 'agent.toolDone': {
        // Update existing tool status to completed, attach output + diffStats
        const doneId = msg.toolId || ''
        const output = msg.output || ''
        const diffStats = msg.diffStats || undefined
        const updateTool = (t: ToolCall): ToolCall => {
          if (t.id !== doneId) return t
          return { ...t, status: msg.status || 'completed', output, diffStats }
        }
        setMessages(prev => {
          const arr = [...prev]
          for (let i = arr.length - 1; i >= 0; i--) {
            const inTools = arr[i].tools?.some(t => t.id === doneId)
            const inSteps = arr[i].steps?.some(s => s.kind === 'tool' && s.tool.id === doneId)
            if (!inTools && !inSteps) continue
            arr[i] = {
              ...arr[i],
              tools: arr[i].tools?.map(updateTool),
              steps: arr[i].steps?.map(s => s.kind === 'tool' ? { kind: 'tool', tool: updateTool(s.tool) } : s),
            }
            break
          }
          return arr
        })
        break
      }

      case 'agent.tool': {
        const tool: ToolCall = { name: msg.tool, input: msg.input || {}, id: msg.toolId || '', result: msg.result || '', status: msg.status || '' }
        // Track text offset at tool start — text after the last tool is the "final output"
        lastToolTextOffsetRef.current = fullTextRef.current.length
        setActiveTools(prev => {
          const existing = prev.findIndex(t => t.id === tool.id)
          if (existing >= 0) {
            const updated = [...prev]
            updated[existing] = { ...updated[existing], ...tool }
            return updated
          }
          return [...prev, tool]
        })
        // Attach to current bot message, or update if tool already exists
        setMessages(prev => {
          const arr = [...prev]
          // Check if this tool ID already exists in any message (update with parsed input)
          for (let i = arr.length - 1; i >= 0; i--) {
            const hasInTools = arr[i].tools?.some(t => t.id === tool.id)
            const hasInSteps = arr[i].steps?.some(s => s.kind === 'tool' && s.tool.id === tool.id)
            if (hasInTools || hasInSteps) {
              arr[i] = {
                ...arr[i],
                tools: arr[i].tools?.map(t => t.id === tool.id ? { ...t, ...tool } : t) ?? arr[i].tools,
                steps: arr[i].steps?.map(s => s.kind === 'tool' && s.tool.id === tool.id
                  ? { kind: 'tool', tool: { ...s.tool, ...tool } }
                  : s) ?? arr[i].steps,
              }
              return arr
            }
          }
          // New tool — attach to current bot message or create placeholder
          if (arr.length && arr[arr.length - 1].bot) {
            const last = arr[arr.length - 1]
            arr[arr.length - 1] = {
              ...last,
              tools: [...(last.tools || []), tool],
              steps: [...(last.steps || []), { kind: 'tool', tool }],
            }
          } else {
            msgAddedRef.current = true
            arr.push({
              author: agentName,
              content: '',
              bot: true,
              ts: Date.now() / 1000,
              tools: [tool],
              steps: [{ kind: 'tool', tool }],
            })
          }
          return arr
        })
        break
      }

      case 'agent.thinking': {
        const delta = msg.delta || ''
        setThinkingText(prev => prev + delta)
        // Attach thinking to current message
        setMessages(prev => {
          const arr = [...prev]
          if (arr.length && arr[arr.length - 1].bot) {
            const last = arr[arr.length - 1]
            arr[arr.length - 1] = { ...last, thinking: (last.thinking || '') + delta }
          }
          return arr
        })
        break
      }

      case 'system': {
        // System-Meldungen (stop/new/Fehler) gehören zur auslösenden Conversation.
        // Der Hub ist geteilt: ohne Filter rendert JEDE Pane das "Agent gestoppt".
        const sysConv = msg.conversationId || ''
        if (sysConv && sysConv !== convIdRef.current) break
        setMessages(prev => [...prev, {
          author: 'System',
          content: msg.content || '',
          ts: Date.now() / 1000,
        }])
        break
      }

      case 'sync': {
        const syncConv = msg.conversationId || ''
        const syncAgent = msg.agentId || ''
        // Wenn ein anderer Client gerade in DIESEM Chat sendet, sehen wir nur sync.
        // Über attach docken wir am laufenden Stream an, damit Tool/Thinking-Events
        // auch hier live ankommen.
        if (syncConv && syncConv === convIdRef.current && hubRef.current?.isOpen()) {
          hubRef.current.send(JSON.stringify({ action: 'attach', conversationId: syncConv }))
        }
        if (syncConv && syncConv === convIdRef.current && !busyRef.current) {
          // Current channel, not streaming — reload messages from DB
          const prevCount = messages.length
          loadHistory(syncConv, 100, { mergeLive: true, scroll: true, force: true }).then(msgs => {
            if (!msgs) return
            // Autoplay new messages (e.g. cron results) only when the pane is idle.
            if (autoplayRef.current && !audioQueue.getState().playingTs && !busyRef.current && msgs.length > prevCount) {
              const last = msgs[msgs.length - 1]
              if (last.bot && last.content && last.author !== 'System') {
                speak(last.content, last.author, last.ts, { source: 'autoplay', segments: last.segments })
              }
            }
          })
        } else if (syncAgent && syncConv !== convIdRef.current) {
          // Different channel — notify App about unread activity
          window.dispatchEvent(new CustomEvent('deck:unread', { detail: { agent: syncAgent, conversationId: syncConv, source: msg.source || '' } }))
        }
        break
      }

      case 'agent.done': {
        const doneConversationId = msg.conversationId || convIdRef.current
        if (doneConversationId) completedStreamAtRef.current[doneConversationId] = Date.now()
        chatTrace('ws.agent.done', {
          conversationId: doneConversationId,
          paneIndex,
          mobile: !!mobile,
          status: String(msg.status || 'completed'),
          textLen: fullTextRef.current.length,
        })
        if (msg.model) setModel(msg.model)
        if (msg.contextTokens) {
          setContextTokens(msg.contextTokens)
        }
        setRunTokenCount(tokenTotalFromUsage(msg))
        if (msg.contextWindow) setContextWindow(msg.contextWindow)
        if (typeof msg.inputTokens === 'number') setRunInputTokens(visibleTokenPart(msg.inputTokens))
        if (typeof msg.outputTokens === 'number') setRunOutputTokens(visibleTokenPart(msg.outputTokens))
        // If no text was received, add error or empty message
        if (!msgAddedRef.current && msg.status === 'error') {
          // Find the last user message for retry
          const lastUserMsg = [...messages].reverse().find(m => m.author === 'Du')
          setMessages(prev => [...prev, {
            author: agentName,
            content: `Fehler: ${msg.error || 'Unbekannter Fehler'}`,
            bot: true,
            ts: Date.now() / 1000,
            errorRetry: lastUserMsg?.content || '',
          }])
        }
        // Fetch memory references for the response
        const responseText = fullTextRef.current
        if (responseText && msg.status !== 'error') {
          fetch(`/api/search/refs?text=${encodeURIComponent(responseText.slice(0, 500))}&limit=4`)
            .then(r => r.json())
            .then(d => {
              if (d.refs?.length) {
                setMessages(prev => {
                  const arr = [...prev]
                  // Find the last bot message
                  for (let i = arr.length - 1; i >= 0; i--) {
                    if (arr[i].bot) {
                      arr[i] = { ...arr[i], refs: d.refs }
                      break
                    }
                  }
                  return arr
                })
              }
            })
            .catch(() => {})
        }
        historyRef.current.push({ role: 'assistant', content: responseText })
        setMessages(prev => prev.map(m => m.tools?.some(t => t.status !== 'completed')
          ? { ...m, tools: m.tools.map(t => t.status === 'completed' ? t : { ...t, status: 'completed' }) }
          : m))
        // Volltext autoritativ in die letzte Bot-Bubble schreiben. Die steps werden
        // sonst rein inkrementell aus deltas gebaut; geht bei einem Verbindungs-
        // abriss ein delta verloren, bleiben die steps (aus denen gerendert wird)
        // verkuerzt, obwohl fullTextRef den kompletten Text haelt. Ergebnis: eine
        // "abgerissene" Bubble bis ein DB-Refresh (Scroll/neue Nachricht) kommt.
        // Hier gleichen wir am Stream-Ende deterministisch ab.
        if (responseText && msg.status !== 'error') {
          setMessages(prev => {
            const arr = [...prev]
            let filled = false
            for (let i = arr.length - 1; i >= 0; i--) {
              const m = arr[i]
              if (!m.bot) continue
              filled = true
              const steps: ChatStep[] = m.steps ? [...m.steps] : []
              const hasTools = steps.some(s => s.kind === 'tool')
              const textLen = steps.reduce((n, s) => n + (s.kind === 'text' ? s.text.length : 0), 0)
              // Schon vollstaendig? Dann nichts anfassen (kein unnoetiger Re-Render).
              if (textLen >= responseText.length && (m.content?.length || 0) >= responseText.length) break
              let nextSteps = steps
              if (!hasTools) {
                // Reiner Text (haeufigster Fall): steps komplett aus dem Volltext
                // neu setzen — 100% korrekt, keine Luecken.
                nextSteps = [{ kind: 'text', text: responseText }]
              } else if (textLen < responseText.length) {
                // Mit Tools verschachtelt: Struktur erhalten, fehlenden Schwanz an
                // den letzten Text-step haengen (bzw. neuen anlegen).
                const tail = responseText.slice(textLen)
                let lastTextIdx = -1
                for (let k = steps.length - 1; k >= 0; k--) { if (steps[k].kind === 'text') { lastTextIdx = k; break } }
                nextSteps = lastTextIdx >= 0
                  ? steps.map((s, k) => (k === lastTextIdx && s.kind === 'text') ? { kind: 'text', text: s.text + tail } : s)
                  : [...steps, { kind: 'text', text: tail }]
              }
              arr[i] = {
                ...m,
                content: (m.content?.length || 0) >= responseText.length ? m.content : responseText,
                steps: nextSteps,
              }
              break
            }
            // Fallback: Kam (z.B. auf Mobile nach kurzem Verbindungsabriss) waehrend des
            // Streams nie eine Bot-Bubble an, gibt es nichts zu fuellen und die Antwort
            // bliebe unsichtbar bis zum naechsten History-Refresh (eigener Send). Dann
            // legen wir hier deterministisch eine neue Bubble aus dem Volltext an.
            if (!filled) {
              arr.push({
                author: agentName,
                content: responseText,
                bot: true,
                ts: Date.now() / 1000,
                tools: [],
                thinking: '',
                steps: [{ kind: 'text', text: responseText }],
              })
            }
            return arr
          })
          msgAddedRef.current = true
        }
        const typewriterEnabled = (() => {
          try {
            const mode = localStorage.getItem('control:responseMode')
            if (mode !== 'live') return false
            return (localStorage.getItem('control:typewriter') ?? 'false') === 'true'
          } catch { return true }
        })()
        const lastBot = [...messages].reverse().find(m => m.bot)
        const messageKey = lastBot ? String(lastBot.id ?? lastBot.ts ?? messages.length) : ''
        if (msg.status !== 'error' && typewriterEnabled && responseText && messageKey) {
          const pending: PendingVisualDone = {
            messageKey,
            token: Date.now(),
            didWork: !!msg.didWork,
            status: String(msg.status || 'completed'),
            conversationId: msg.conversationId || '',
            responseText,
          }
          pendingVisualDoneRef.current = pending
          setVisualFinalizeKey(messageKey)
          setVisualFinalizeToken(pending.token)
        } else {
          finalizeVisualDone({
            messageKey: messageKey || `done-${Date.now()}`,
            token: Date.now(),
            didWork: !!msg.didWork,
            status: String(msg.status || 'completed'),
            conversationId: msg.conversationId || '',
            responseText,
          })
        }
        break
      }
    }
  }, [finalizeVisualDone, isRecentlyCompletedStream, isStaleStreamForCurrentMessages, loadHistory, messages, mobile, notifyConversationBusy, paneIndex, stopTimer])

  // Dem Hub immer die aktuelle Handler-Version geben (latest-ref-Pattern). So
  // muss sich der WS-Handler nie neu binden, obwohl handleWsMessage von
  // `messages` abhängt — vorher band er pro Token neu.
  handleWsMessageRef.current = handleWsMessage

  // Beim Mount am Hub anmelden — sonst empfängt eine frische Pane (noch nichts
  // gesendet) keine Server-Broadcasts wie pane.input. Eine inaktive Mobile-Pane
  // meldet sich ab; der Hub schliesst den Socket, sobald die letzte Pane geht.
  useEffect(() => {
    if (mobile && !isActive) {
      hubRef.current?.release()
      hubRef.current = null
      return
    }
    acquireHub()
  }, [acquireHub, isActive, mobile])

  // Bei Chat-Wechsel an einen evtl. laufenden Stream im Backend andocken.
  // Backend antwortet mit stream.snapshot wenn etwas läuft, sonst nichts.
  useEffect(() => {
    const cid = convIdState || externalConvId || ''
    if (!cid) return
    if (mobile && !isActiveRef.current) return
    const open = hubRef.current?.isOpen() ?? false
    if (open) hubRef.current!.send(JSON.stringify({ action: 'attach', conversationId: cid }))
    void syncActiveStreamState({ attach: open, clearIfIdle: true })
  }, [convIdState, externalConvId, mobile, syncActiveStreamState])

  // Wenn App aus dem Hintergrund kommt (PWA/Mobile-Reopen): erneut attach,
  // damit ein evtl. weiterlaufender Stream sofort wieder live wird.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return
      if (mobile && !isActiveRef.current) return
      const cid = convIdRef.current
      if (!cid) return
      const open = hubRef.current?.isOpen() ?? false
      if (open) hubRef.current!.send(JSON.stringify({ action: 'attach', conversationId: cid }))
      void syncActiveStreamState({ attach: open, clearIfIdle: true })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [mobile, syncActiveStreamState])

// Persist messages to localStorage so they survive server restarts/reloads (debounced)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const cid = convIdRef.current
    if (!cid || messages.length === 0) return
    const last = messages[messages.length - 1]
    const raf = requestAnimationFrame(() => {
      chatTrace('messages.visible', {
        conversationId: cid,
        paneIndex,
        mobile: !!mobile,
        busy,
        count: messages.length,
        sourceConversationId: messagesConvIdRef.current,
        lastAuthor: last?.author || '',
        lastBot: !!last?.bot,
        lastLen: typeof last?.content === 'string' ? last.content.length : 0,
        lastIncomplete: !!last?.incomplete,
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [busy, messages, mobile, paneIndex])

  useEffect(() => {
    const cid = convIdRef.current
    if (cid && messages.length > 0) {
      updateChatHistoryCache(cid, messages, 100)
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
      persistTimerRef.current = setTimeout(() => {
        try {
          const slim = messages.slice(-50).map(m => ({ author: m.author, content: m.content, bot: m.bot, ts: m.ts }))
          localStorage.setItem(`deck:msgs:${cid}`, JSON.stringify(slim))
        } catch {}
      }, 2000)
    }
    return () => { if (persistTimerRef.current) clearTimeout(persistTimerRef.current) }
  }, [messages])

  // Broadcast busy state for mobile agent tabs
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('deck:agentBusy', { detail: { agentId: agent, busy } }))
  }, [agent, busy])

  // Watchdog: wenn busy, regelmäßig den echten Backend-Stream-Stand prüfen.
  useEffect(() => {
    if (!busy) return
    const watchdog = setInterval(() => {
      void syncActiveStreamState({ attach: false, clearIfIdle: true })
    }, 5000)
    return () => { clearInterval(watchdog) }
  }, [busy, syncActiveStreamState])

  // Nachzieh-Poll gegen den "Zombie"-Fall: bei wackeligem Netz kann der WS halb
  // haengen (kein sauberer Close, verschluckte Schluss-Events), sodass eine in der
  // DB laengst fertige Antwort nie gerendert wird — sie taucht erst beim naechsten
  // Send auf. Der busy-Watchdog greift hier nicht, weil busy evtl. schon faelschlich
  // auf false steht. Solange die letzte sichtbare Nachricht vom User stammt (also
  // eine Antwort aussteht) und das Pane sichtbar ist, ziehen wir die History
  // unabhaengig vom Verbindungsstatus leise nach, bis die Antwort da ist oder ein
  // Cap erreicht ist.
  useEffect(() => {
    if (mobile && !isActiveRef.current) return
    const last = messages[messages.length - 1]
    if (!last || last.author === 'System') return
    // Poll laeuft solange eine Antwort aussteht (letzte = User) ODER die letzte
    // Bot-Bubble noch unfertig ist (leer oder als incomplete markiert): ein
    // verschlucktes Schluss-Event darf nicht dazu fuehren, dass eine in der DB
    // fertige Antwort erst beim naechsten Send sichtbar wird.
    if (last.bot && !last.incomplete && (last.content?.length || 0) > 0) return
    let ticks = 0
    const MAX_TICKS = 40 // ~2 min bei 3s
    const poll = setInterval(() => {
      ticks += 1
      if (document.visibilityState === 'visible' && convIdRef.current) {
        refreshMessages({ scroll: false })
      }
      if (ticks >= MAX_TICKS) clearInterval(poll)
    }, 3000)
    return () => clearInterval(poll)
  }, [messages, mobile, refreshMessages])

  // iOS-PWA malt WS-getriebene State-Updates im Vordergrund manchmal erst beim
  // naechsten Touch — die Daten sind da (Backend bestaetigt: der Absender ist
  // Subscriber #1 und bekommt jeden Delta), nur der Repaint bleibt aus. Solange
  // eine Antwort laeuft und das Pane sichtbar ist, frischen wir darum ~1x/s die
  // Message-Referenz auf und erzwingen so einen Repaint. Rein lokal, kein Netz-Call.
  useEffect(() => {
    if (!mobile || !busy) return
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (mobile && !isActiveRef.current) return
      setMessages(prev => (prev.length ? prev.slice() : prev))
    }, 1000)
    return () => clearInterval(id)
  }, [mobile, busy])

  // Cleanup WebSocket + timer on unmount
  useEffect(() => {
    return () => {
      hubRef.current?.release(); hubRef.current = null
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    }
  }, [])

  // Listen for conversation selection (from InfoPane chat list, etc.)
  useEffect(() => {
    const handler = (e: Event) => {
      const conv = (e as CustomEvent).detail
      if (!conv?.conversationId) return
      // Only react if this event targets our pane (or no pane specified for backwards compat)
      if (conv.paneIndex !== undefined && conv.paneIndex !== paneIndex) return
      chatTrace('chat.switch.event', { conversationId: conv.conversationId, paneIndex, mobile: !!mobile, agent: conv.agent || agent })
      // Switch agent if needed
      if (conv.agent && conv.agent !== agent) {
        setAgent(conv.agent)
      }
      historyLoadSeqRef.current += 1
      convIdRef.current = conv.conversationId
      setConversationId(conv.conversationId)
      showCachedOrEmpty(conv.conversationId)
      onConversationChange?.(conv.conversationId)
      void loadHistory(conv.conversationId, 100, { mergeLive: true, scroll: true })
    }
    window.addEventListener('deck:loadConversation', handler)
    return () => window.removeEventListener('deck:loadConversation', handler)
  }, [agent, loadHistory, mobile, onConversationChange, paneIndex, showCachedOrEmpty])

  // Listen for scroll-to-message from InfoPane search results
  useEffect(() => {
    const handler = (e: Event) => {
      const { agent: targetAgent, conversationId, ts } = (e as CustomEvent).detail
      // Accept if this pane's defaultAgent matches OR if internal agent was switched
      if (targetAgent !== defaultAgent && targetAgent !== agent) return

      // Switch internal agent if needed
      if (targetAgent !== agent) setAgent(targetAgent)

      historyLoadSeqRef.current += 1
      convIdRef.current = conversationId
      setConversationId(conversationId)
      showCachedOrEmpty(conversationId, 200)
      loadHistory(conversationId, 200, { mergeLive: true })
        .then(msgs => {
          if (!msgs) return
          // Scroll to closest message after React renders the new messages
          requestAnimationFrame(() => {
            setTimeout(() => {
              // Scope search to this pane's container
              const pane = document.querySelector(`[data-agent-pane="${defaultAgent}"]`)
              const all = (pane || document).querySelectorAll<HTMLElement>('[data-ts]')
              let best: HTMLElement | null = null
              let bestDist = Infinity
              all.forEach(el => {
                const elTs = parseFloat(el.dataset.ts || '0')
                const dist = Math.abs(elTs - ts)
                if (dist < bestDist) { bestDist = dist; best = el as HTMLElement }
              })
              const target = best as HTMLElement | null
              if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' })
                target.style.outline = '1px solid rgba(232,168,76,0.4)'
                target.style.borderRadius = '12px'
                setTimeout(() => { target.style.outline = ''; target.style.borderRadius = '' }, 2000)
              }
            }, 100)
          })
        })
    }
    window.addEventListener('control:scrollToMessage', handler)
    return () => window.removeEventListener('control:scrollToMessage', handler)
  }, [agent, defaultAgent, loadHistory, showCachedOrEmpty])

  // Load conversation: external conversationId oder Empty State (keine Default-Kanäle mehr)
  useEffect(() => {
    const targetConvId = externalConvId || ''
    const key = project ? `project:${project}` : `conv:${targetConvId}`
    if (loaded === key) return
    setLoaded(key)
    const loadSeq = ++historyLoadSeqRef.current
    chatTrace('chat.load.effect', { conversationId: targetConvId, project: project || '', key, paneIndex, mobile: !!mobile })

    if (project) {
      // Project mode: find latest project conversation
      fetch(`/api/conversations?project=${encodeURIComponent(project)}&limit=1`)
        .then(r => r.json())
        .then(data => {
          if (loadSeq !== historyLoadSeqRef.current) return Promise.resolve({ cid: '', data: { messages: [] } })
          const conv = data.conversations?.[0]
          if (conv) {
            convIdRef.current = conv.id
            setConversationId(conv.id)
            showCachedOrEmpty(conv.id)
            onConversationChange?.(conv.id)
            return loadHistory(conv.id, 100, { mergeLive: true }).then(() => ({ cid: conv.id }))
          }
          convIdRef.current = ''
          messagesConvIdRef.current = ''
          setConversationId('')
          setMessages([])
          historyRef.current = []
          return Promise.resolve({ cid: '', data: { messages: [] } })
        })
        .then(result => {
          if (loadSeq !== historyLoadSeqRef.current || !result.cid) return
        })
        .catch(() => {})
    } else if (!targetConvId) {
      // Empty State: kein Chat geladen, wartet auf erste Nachricht.
      convIdRef.current = ''
      messagesConvIdRef.current = ''
      setConversationId('')
      setMessages([])
      historyRef.current = []
    } else {
      const cid = targetConvId
      chatTrace('chat.load.conversation', { conversationId: cid, paneIndex, mobile: !!mobile })
      convIdRef.current = cid
      setConversationId(cid)
      showCachedOrEmpty(cid)
      onConversationChange?.(cid)
      loadHistory(cid, 100, { mergeLive: true, scroll: true })
        .then(dbMsgs => {
          if (loadSeq !== historyLoadSeqRef.current) return
          if (!dbMsgs) return
          localStorage.setItem(`deck:lastSeen:${agent}`, String(Date.now() / 1000))
          void syncActiveStreamState({ attach: false, clearIfIdle: true })
        })
    }
  }, [agent, project, loaded, externalConvId, loadHistory, mobile, onConversationChange, paneIndex, showCachedOrEmpty, syncActiveStreamState])

  // Effort und Deep-Mode hängen pro Chat (convId), nicht pro Agent — sonst spiegelt
  // sich eine Auswahl in alle Composer mit demselben Agent. Für leere Chats fällt der
  // State auf den Agent-Default zurück, damit neue Chats die letzte Wahl mitnehmen.
  const activeConvKey = externalConvId || convIdState
  const readEffort = (cid: string): 'low' | 'medium' | 'high' | 'xhigh' | 'max' => {
    const tryKey = (k: string) => {
      const v = localStorage.getItem(k)
      if (v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max') return v
      return null
    }
    if (cid) {
      const v = tryKey(`control:effort:conv:${cid}`)
      if (v) return v
    }
    const a = tryKey(`control:effort:${defaultAgent}`)
    if (a) return a
    const legacy = localStorage.getItem(`control:fastMode:${defaultAgent}`)
    return legacy === 'true' ? 'low' : 'xhigh'
  }
  const readDeep = (cid: string): boolean => {
    if (cid) {
      const v = localStorage.getItem(`control:deepMode:conv:${cid}`)
      if (v === 'true' || v === 'false') return v === 'true'
    }
    return localStorage.getItem(`control:deepMode:${defaultAgent}`) === 'true'
  }
  const readDual = (cid: string): boolean => {
    if (cid) {
      const v = localStorage.getItem(`control:dualMode:conv:${cid}`)
      if (v === 'true' || v === 'false') return v === 'true'
    }
    return localStorage.getItem(`control:dualMode:${defaultAgent}`) === 'true'
  }
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'xhigh' | 'max'>(() => readEffort(activeConvKey))
  const [deepMode, setDeepMode] = useState(() => readDeep(activeConvKey))
  const [dualMode, setDualMode] = useState(() => readDual(activeConvKey))
  // Bei Chat-Wechsel: passende Werte für die neue convId laden.
  useEffect(() => {
    setEffort(readEffort(activeConvKey))
    setDeepMode(readDeep(activeConvKey))
    setDualMode(readDual(activeConvKey))
    // Server-Prefs überschreiben localStorage, damit Desktop ↔ Mobile am selben Stand sind.
    if (activeConvKey) {
      fetch(`/api/conversations/${activeConvKey}/prefs`)
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d) return
          const e = d.effort
          if (e === 'low' || e === 'medium' || e === 'high' || e === 'xhigh' || e === 'max') {
            setEffort(e)
            localStorage.setItem(`control:effort:conv:${activeConvKey}`, e)
          }
          if (typeof d.deepMode === 'boolean') {
            setDeepMode(d.deepMode)
            localStorage.setItem(`control:deepMode:conv:${activeConvKey}`, String(d.deepMode))
          }
          if (typeof d.dualMode === 'boolean') {
            setDualMode(d.dualMode)
            localStorage.setItem(`control:dualMode:conv:${activeConvKey}`, String(d.dualMode))
          }
        })
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvKey, defaultAgent])

  // Live-Sync: anderer Client (Desktop oder Mobile) ändert die Prefs für DIESEN Chat.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if (!d.conversationId || d.conversationId !== activeConvKey) return
      if (typeof d.effort === 'string' && (d.effort === 'low' || d.effort === 'medium' || d.effort === 'high' || d.effort === 'xhigh' || d.effort === 'max')) {
        setEffort(d.effort)
        localStorage.setItem(`control:effort:conv:${activeConvKey}`, d.effort)
      }
      if (typeof d.deepMode === 'boolean') {
        setDeepMode(d.deepMode)
        localStorage.setItem(`control:deepMode:conv:${activeConvKey}`, String(d.deepMode))
      }
      if (typeof d.dualMode === 'boolean') {
        setDualMode(d.dualMode)
        localStorage.setItem(`control:dualMode:conv:${activeConvKey}`, String(d.dualMode))
      }
    }
    window.addEventListener('deck:convPrefsUpdate', handler)
    return () => window.removeEventListener('deck:convPrefsUpdate', handler)
  }, [activeConvKey])

  // Send via WebSocket
  const send = useCallback(async (text: string, context?: string, attachments?: Attachment[], clientMessageIdOverride?: string) => {
    if (!cfg) return
    const cleanText = text.trim()
    const readyAttachments = attachments?.filter(a => a.url && !a.uploading)?.map(a => ({ name: a.name, url: a.url, type: a.type, size: a.size }))
    if (!cleanText && !(readyAttachments?.length)) return
    if (autoplay) audioQueue.warmUp()
    pendingVisualDoneRef.current = null
    setVisualFinalizeKey(null)
    setVisualFinalizeToken(0)
    setBusy(true)
    startTimer()

    const fullMessage = context ? `Kontext:\n\`\`\`\n${context.slice(0, 8000)}\n\`\`\`\n\n${cleanText}` : cleanText

    // Optimistisch: User-Message sofort zeigen, damit Empty State direkt verschwindet.
    messagesConvIdRef.current = convIdRef.current
    setMessages(prev => [...prev, { author: 'Du', content: cleanText, ts: Date.now() / 1000, attachments }])
    historyRef.current.push({ role: 'user', content: fullMessage })

    // Lazy-create: wenn keine Conversation geladen, jetzt eine anlegen.
    let cid = convIdRef.current
    if (!cid) {
      try {
        const res = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent, engine, ...(project ? { project } : {}) }),
        })
        const data = await res.json()
        if (data?.id) {
          cid = data.id as string
          convIdRef.current = cid
          setConversationId(cid)
          onConversationChange?.(cid)
          window.dispatchEvent(new CustomEvent('deck:chatsChanged'))
        } else {
          setBusy(false)
          stopTimer()
          return
        }
      } catch {
        setBusy(false)
        stopTimer()
        return
      }
    }

    // Reset refs
    msgAddedRef.current = false
    fullTextRef.current = ''
    setThinkingText('')
    setPhaseLabel('')
    setActiveTools([])

    // Einheitliche Aktion — Backend liest die Engine aus der Conversation-Row.
    // clientMessageId: Idempotenz-ID gegen Doppel-Sends (z.B. nach WS-Reconnect).
    const clientMessageId = clientMessageIdOverride || (
      (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    )
    const payload = {
      action: 'send',
      agentId: agent,
      paneIndex,
      message: fullMessage,
      model,
      project,
      conversationId: cid,
      effort,
      deepMode,
      verbosity: localStorage.getItem('control:verbosity') || 'brief',
      clientKind: mobile ? 'mobile' : 'desktop',
      clientMessageId,
      ...(readyAttachments?.length ? { attachments: readyAttachments } : {}),
    }

    const raw = JSON.stringify(payload)
    hubSend(raw)
    // Refresh after short delay so user message gets its DB id (enables edit/delete)
    setTimeout(() => refreshMessages({ scroll: false }), 800)
  }, [agent, cfg, engine, project, startTimer, hubSend, refreshMessages, deepMode, effort, mobile, model])

  // Resume: abgerissene Agent-Antwort in derselben Bubble fortsetzen.
  // Backend liefert full = bisher + neu, der agent.text-Handler aktualisiert
  // die letzte Bot-Bubble in place; agent.done refresht aus der DB (incomplete=0).
  const handleResume = useCallback((idStr: string) => {
    const id = Number(idStr)
    const cid = convIdRef.current
    if (engine !== 'claude' || !id || busy || !cid) return
    const seed = messages.find(m => m.id === id)?.content || ''
    fullTextRef.current = seed
    msgAddedRef.current = true
    // Steps mit dem bisherigen Text seeden, damit der Fortsetzungs-Delta angehängt
    // wird statt die Bubble auf nur den neuen Text zu kürzen.
    setMessages(prev => prev.map(m =>
      m.id === id && !(m.steps && m.steps.length) && !(m.segments && m.segments.length)
        ? { ...m, steps: [{ kind: 'text', text: m.content }] }
        : m
    ))
    setThinkingText('')
    setPhaseLabel('')
    setActiveTools([])
    setBusy(true)
    startTimer()
    const payload = {
      action: 'send',
      agentId: agent,
      paneIndex,
      resumeRowId: id,
      model,
      project,
      conversationId: cid,
      effort,
      deepMode,
      verbosity: localStorage.getItem('control:verbosity') || 'brief',
      clientKind: mobile ? 'mobile' : 'desktop',
    }
    hubSend(JSON.stringify(payload))
  }, [agent, busy, messages, project, startTimer, hubSend, deepMode, effort, mobile, model, engine])

  useEffect(() => {
    if (engine !== 'claude') return
    if (busy || messages.length === 0) return
    const candidate = [...messages].reverse().find(m => (
      m.incomplete && m.bot && m.id && m.content.trim()
    ))
    if (!candidate?.id) return
    const id = Number(candidate.id)
    if (!id || autoResumeAttemptedRef.current.has(id)) return
    // Ein kurzer Verbindungsabriss lässt die Row scheinbar unfertig, obwohl das
    // Backend sie längst final gespeichert hat. Erst frisch nachladen und nur
    // fortsetzen, wenn sie dann immer noch incomplete ist — sonst flackert die
    // Bubble durch ein unnötiges Resume.
    if (!autoResumeRecheckedRef.current.has(id)) {
      autoResumeRecheckedRef.current.add(id)
      window.setTimeout(() => refreshMessages({ scroll: false }), 1200)
      return
    }
    autoResumeAttemptedRef.current.add(id)
    window.setTimeout(() => handleResume(String(id)), 150)
  }, [busy, handleResume, messages, engine, refreshMessages])

  // Voice-Send-Handler wird unten nach `enqueue` registriert (siehe Block "Voice-Send queue-aware").
  // Pane-PTT-Listener ebenfalls weiter unten — busy-aware mit Queue.

  // Listen for recording state from MobileApp
  useEffect(() => {
    if (!mobile) return
    const onRec = (e: Event) => setMobileRecording((e as CustomEvent).detail.recording)
    const onTrans = (e: Event) => setMobileTranscribing((e as CustomEvent).detail.transcribing)
    const onPaused = (e: Event) => setMobilePaused((e as CustomEvent).detail.paused)
    window.addEventListener('deck:recordingState', onRec)
    window.addEventListener('deck:transcribingState', onTrans)
    window.addEventListener('deck:pausedState', onPaused)
    return () => {
      window.removeEventListener('deck:recordingState', onRec)
      window.removeEventListener('deck:transcribingState', onTrans)
      window.removeEventListener('deck:pausedState', onPaused)
    }
  }, [mobile])

  // Listen for skill injection from InfoPane
  useEffect(() => {
    const handler = (e: Event) => {
      const { agentId, text } = (e as CustomEvent).detail
      if (agentId === agent && text) {
        setQuoteText(text + '\n')
      }
    }
    window.addEventListener('deck:useSkill', handler)
    return () => window.removeEventListener('deck:useSkill', handler)
  }, [agent])

  const handleProjectChange = useCallback((p: string) => { setProject(p); setLoaded('') }, [])
  const handleAgentChange = useCallback((a: string) => {
    if (mobile) {
      onAgentFocus?.(a)
      return
    }
    // Switch to new agent — create a new chat via parent
    if (onAgentSwitch) {
      onAgentSwitch(a)
    } else {
      setAgent(a)
    }
  }, [mobile, onAgentSwitch])

  // Slash commands
  const addSystem = useCallback((content: string) => {
    setMessages(prev => [...prev, { author: 'System', content, ts: Date.now() / 1000 }])
  }, [])

  const handleCommand = useCallback((cmd: string, args: string) => {
    const sendWs = (payload: object) => {
      hubSend(JSON.stringify(payload))
    }

    switch (cmd) {
      case '/new':
        // Reset backend session (context fresh), but keep chat history visible
        sendWs({ action: 'command', command: 'new', agentId: agent, conversationId: convIdRef.current })
        addSystem('Neue Session gestartet.')
        break

      case '/stop':
        if (busy) {
          const cid = convIdRef.current
          sendWs({ action: 'command', command: 'stop', agentId: agent, conversationId: cid })
          stopTimer()
          setBusy(false)
          setThinkingText('')
          setPhaseLabel('')
          setActiveTools([])
          notifyConversationBusy(cid, false, { done: false })
        } else {
          addSystem('Kein Agent aktiv.')
        }
        break

      case '/model':
        if (args) {
          setModel(args)
          sendWs({ action: 'command', command: 'model', agentId: agent, args })
          addSystem(`Model gewechselt: ${args}`)
        } else {
          addSystem(`Aktuelles Model: ${model || 'Standard'}. Verwendung: /model <name>`)
        }
        break

      case '/consult':
        if (!args.trim()) {
          addSystem('Verwendung: /consult [claude|codex] <frage>')
        } else {
          sendWs({
            action: 'command',
            command: 'consult',
            agentId: agent,
            conversationId: convIdRef.current,
            project,
            engine,
            clientKind: mobile ? 'mobile' : 'desktop',
            args,
          })
        }
        break

      case '/dual': {
        const raw = args.trim().toLowerCase()
        const next = raw === 'on' ? true : raw === 'off' ? false : !dualMode
        setDualMode(next)
        const cid = externalConvId || convIdState || convIdRef.current
        if (cid) {
          localStorage.setItem(`control:dualMode:conv:${cid}`, String(next))
          fetch(`/api/conversations/${cid}/prefs`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dualMode: next, source: mobile ? 'mobile' : 'desktop' }),
          }).catch(() => {})
        }
        localStorage.setItem(`control:dualMode:${defaultAgent}`, String(next))
        addSystem(next ? `Dual-Modus aktiv: Agent arbeitet mit ${engine === 'codex' ? 'Claude Code' : 'Codex'}.` : 'Dual-Modus aus.')
        break
      }

      case '/thinking':
        if (args && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive'].includes(args)) {
          sendWs({ action: 'command', command: 'thinking', agentId: agent, args })
          addSystem(`Thinking-Level: ${args}`)
        } else {
          addSystem('Verwendung: /thinking off|low|medium|high|adaptive')
        }
        break


      case '/tasks':
        sendWs({ action: 'command', command: 'tasks', agentId: agent })
        setBusy(true)
        startTimer()
        break

      case '/flow':
        sendWs({ action: 'command', command: 'flow', agentId: agent })
        setBusy(true)
        startTimer()
        break

      case '/goal':
        if (!args.trim()) {
          addSystem('Verwendung: /goal <was du am Ende sehen willst>')
          break
        }
        send(
          `[Ziel] ${args.trim()}\n\n` +
          `Bitte iteriere selbständig darauf hin. Plane die Schritte, ` +
          `arbeite sie ab, prüfe selbst, ob das Ziel sichtbar erreicht ist, ` +
          `und melde dich erst zurück, wenn entweder das Ziel steht oder ` +
          `eine echte Blockade da ist, die meine Entscheidung braucht.`
        )
        break

      case '/memory':
        if (!args.trim()) {
          addSystem('Verwendung: /memory <was ich mir merken soll>')
          break
        }
        send(
          `Bitte trag das in brain/MEMORY.md ein, als dauerhafte ` +
          `Entscheidung/Notiz, sauber datiert und einsortiert:\n\n${args.trim()}`
        )
        break

      case '/jobs':
        (async () => {
          try {
            const res = await fetch('/api/cron-runs?hours=24')
            const data = await res.json()
            const runs: Array<{ slug?: string; status?: string; finished_at?: string; started_at?: string }> = data?.runs || data || []
            if (!runs.length) {
              addSystem('Keine Job-Läufe in den letzten 24h.')
              return
            }
            const lines = runs.slice(0, 20).map(r => {
              const when = (r.finished_at || r.started_at || '').slice(11, 16)
              const mark = r.status === 'ok' ? '✓' : r.status === 'error' ? '✗' : '·'
              return `${mark} ${when}  ${r.slug || '?'}  ${r.status || ''}`.trim()
            })
            addSystem('Job-Läufe (letzte 24h):\n' + lines.join('\n'))
          } catch (e) {
            addSystem(`Fehler beim Laden der Job-Läufe: ${e}`)
          }
        })()
        break
    }
  }, [agent, busy, model, hubSend, addSystem, notifyConversationBusy, stopTimer, startTimer, send, dualMode, externalConvId, convIdState, defaultAgent, engine, mobile, project])

  // Message Queue (serverseitig persistent — überlebt Gerätewechsel und Session-Unterbrechungen)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const queueRef = useRef<QueueItem[]>([])
  queueRef.current = queue

  // Queue vom Backend laden wenn Conv wechselt.
  useEffect(() => {
    if (!activeConvKey) { setQueue([]); return }
    fetch(`/api/conversations/${activeConvKey}/queue`)
      .then(r => r.json())
      .then(data => setQueue((data.items || []).map((i: { id: string; text: string; attachments?: Attachment[]; ts: number }) => ({
        id: i.id, text: i.text, attachments: i.attachments, ts: i.ts,
      }))))
      .catch(() => setQueue([]))
  }, [activeConvKey])

  const enqueue = useCallback((text: string, _context?: string, attachments?: Attachment[], clientMessageId?: string) => {
    const cleanText = text.trim()
    const readyAttachments = attachments?.filter(a => a.url && !a.uploading)
    if (!cleanText && !(readyAttachments?.length)) return
    if (queueRef.current.length >= 5) return // Max 5
    const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID() : `${Date.now()}`
    const item: QueueItem = { id, text: cleanText, attachments: readyAttachments, ts: Date.now() / 1000, clientMessageId }
    setQueue(prev => [...prev, item])
    if (activeConvKey) {
      fetch(`/api/conversations/${activeConvKey}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, text: cleanText, attachments: readyAttachments || [], agentId: agent }),
      }).catch(() => {})
    }
  }, [activeConvKey, agent])

  // Aktuelle Composer-Anhaenge in der Pane merken, damit Voice- und Backend-Sends sie mitnehmen.
  // Ref fuer Send-Pfade, State fuer das Mini-Display am eingeklappten Composer.
  const pendingAttachmentsRef = useRef<Attachment[]>([])
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([])
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if ((d.paneIndex ?? 0) !== paneIndex) return
      const next: Attachment[] = d.attachments || []
      pendingAttachmentsRef.current = next
      setPendingAttachments(next)
    }
    window.addEventListener('deck:composerAttachments', handler)
    return () => window.removeEventListener('deck:composerAttachments', handler)
  }, [paneIndex])
  const consumePendingAttachments = useCallback(() => {
    pendingAttachmentsRef.current = []
    setPendingAttachments([])
    window.dispatchEvent(new CustomEvent('deck:consumeComposerAttachments', { detail: { paneIndex } }))
    if (mobile) {
      window.dispatchEvent(new CustomEvent('deck:consumeMobileAttachments', { detail: { paneIndex } }))
    }
  }, [paneIndex, mobile])

  const sendMiniComposer = useCallback(() => {
    const text = miniComposerText.trim()
    const atts = pendingAttachmentsRef.current
    const passAtts = atts.length > 0 ? atts : undefined
    if (!text && !passAtts) return
    if (busy) enqueue(text, undefined, passAtts); else send(text, undefined, passAtts)
    if (passAtts) consumePendingAttachments()
    setMiniComposerText('')
    setMiniComposerOpen(false)
  }, [miniComposerText, busy, enqueue, send, consumePendingAttachments])

  const pasteIntoMiniComposer = useCallback(async () => {
    try {
      const text = (await navigator.clipboard?.readText?.() || '').trim()
      if (!text) return
      setMiniComposerText(prev => {
        if (!prev.trim()) return text
        const spacer = prev.endsWith('\n') || prev.endsWith(' ') ? '' : '\n'
        return `${prev}${spacer}${text}`
      })
      window.setTimeout(() => miniComposerInputRef.current?.focus(), 0)
    } catch {
      miniComposerInputRef.current?.focus()
    }
  }, [])

  // Voice-Send queue-aware: wenn busy → in Queue, sonst direkt senden.
  // paneIndex filtert auf Mobile, wo mehrere Slots mit gleichem Agent existieren können.
  useEffect(() => {
    const handler = (e: Event) => {
      const { agentId, text, paneIndex: targetPane } = (e as CustomEvent).detail || {}
      if (targetPane !== undefined && targetPane !== paneIndex) return
      if (agentId === defaultAgent && agentId === agent && text) {
        const atts = pendingAttachmentsRef.current
        const passAtts = atts.length > 0 ? atts : undefined
        if (busy) enqueue(text, undefined, passAtts); else send(text, undefined, passAtts)
        if (passAtts) consumePendingAttachments()
      }
    }
    window.addEventListener('deck:voiceSend', handler)
    return () => window.removeEventListener('deck:voiceSend', handler)
  }, [defaultAgent, agent, busy, send, enqueue, paneIndex, consumePendingAttachments])

  // KlausFlow Pane-PTT: Transkripte vom lokalen Swift-Client landen hier.
  // handleWsMessage filtert bereits auf paneIndex, also kommt das Event nur an,
  // wenn dieses Pane gemeint ist. Busy → in die Queue, sonst direkt senden.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      if (detail.paneIndex !== paneIndex) return
      const text = String(detail.text || '').trim()
      if (!text) return
      const eventId = typeof detail.eventId === 'string' ? detail.eventId.trim() : ''
      const clientMessageId = eventId ? `pane-input:${eventId}` : undefined
      const atts = pendingAttachmentsRef.current
      const passAtts = atts.length > 0 ? atts : undefined
      if (busy) enqueue(text, undefined, passAtts, clientMessageId); else send(text, undefined, passAtts, clientMessageId)
      if (passAtts) consumePendingAttachments()
    }
    window.addEventListener('deck:paneInput', handler)
    return () => window.removeEventListener('deck:paneInput', handler)
  }, [paneIndex, busy, send, enqueue, consumePendingAttachments])

  // Server-Restart-Sync: nach einem Restart meldet das ausloesende Frontend die
  // gekappten convIds, das Backend broadcastet sie als 'server.back'. Betroffene
  // Panes laden still neu; eine Fortsetzung passiert nur ueber die incomplete-Row-Logik.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      const ids: string[] = Array.isArray(detail.conversationIds) ? detail.conversationIds.map(String) : []
      const cid = convIdRef.current
      if (!cid || !ids.includes(cid)) return
      const eventId = String(detail.eventId || '')
      const key = `${eventId}:${cid}`
      if (_serverBackSeen.has(key)) return
      _serverBackSeen.add(key)
      refreshMessages({ scroll: false })
      window.setTimeout(() => refreshMessages({ scroll: false }), 1200)
    }
    window.addEventListener('deck:serverBack', handler)
    return () => window.removeEventListener('deck:serverBack', handler)
  }, [refreshMessages])

  const removeFromQueue = useCallback((id: string) => {
    setQueue(prev => prev.filter(q => q.id !== id))
    if (activeConvKey) {
      fetch(`/api/conversations/${activeConvKey}/queue/${id}`, { method: 'DELETE' }).catch(() => {})
    }
  }, [activeConvKey])

  const clearQueue = useCallback(() => {
    const ids = queueRef.current.map(q => q.id)
    setQueue([])
    if (activeConvKey) {
      ids.forEach(id => {
        fetch(`/api/conversations/${activeConvKey}/queue/${id}`, { method: 'DELETE' }).catch(() => {})
      })
    }
  }, [activeConvKey])

  const moveInQueue = useCallback((id: string, direction: -1 | 1) => {
    setQueue(prev => {
      const idx = prev.findIndex(q => q.id === id)
      if (idx < 0) return prev
      const target = idx + direction
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[idx], next[target]] = [next[target], next[idx]]
      // Reihenfolge serverseitig persistent machen, damit auch der
      // browser-unabhaengige Queue-Worker in der neuen Reihenfolge dispatcht.
      if (activeConvKey) {
        fetch(`/api/conversations/${activeConvKey}/queue/order`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: next.map(q => q.id) }),
        }).catch(() => {})
      }
      return next
    })
  }, [activeConvKey])

  // Auto-dispatch: when agent finishes and queue has items, send next
  const prevBusyForQueue = useRef(false)
  useEffect(() => {
    if (prevBusyForQueue.current && !busy && queueRef.current.length > 0) {
      const next = queueRef.current[0]
      removeFromQueue(next.id)
      setTimeout(() => send(next.text, undefined, next.attachments, next.clientMessageId), 400)
    }
    prevBusyForQueue.current = busy
  }, [busy, send, removeFromQueue])

  // Safety net: if queue has items but agent is idle, dispatch after short delay
  useEffect(() => {
    if (queue.length === 0 || busy) return
    const timer = setTimeout(() => {
      if (!busy && queueRef.current.length > 0) {
        const next = queueRef.current[0]
        removeFromQueue(next.id)
        send(next.text, undefined, next.attachments, next.clientMessageId)
      }
    }, 800)
    return () => clearTimeout(timer)
  }, [queue, busy, send, removeFromQueue])

  const [quoteText, setQuoteText] = useState('')
  const [autoplay, setAutoplay] = useState(() => {
    const g = localStorage.getItem('control:autoplay')
    if (g !== null) return g === 'true'
    return localStorage.getItem(`control:autoplay:${defaultAgent}`) === 'true'
  })
  const autoplayRef = useRef(autoplay)
  autoplayRef.current = autoplay
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  // Autoplay wird in der InfoPane-Einstellungs-Sektion umgeschaltet und
  // per Custom-Event broadcasted; jeder ChatPane aktualisiert seinen State.
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ enabled: boolean; agent?: string }>).detail
      if (!detail) return
      if (detail.agent && detail.agent !== defaultAgent) return
      setAutoplay(detail.enabled)
      if (!detail.enabled) audioQueue.stopCurrent()
    }
    window.addEventListener('deck:autoplayChanged', onChange as EventListener)
    return () => window.removeEventListener('deck:autoplayChanged', onChange as EventListener)
  }, [defaultAgent])
  const [contextTokens, setContextTokens] = useState(0)
  const [contextWindow, setContextWindow] = useState(0)
  const [runTokenCount, setRunTokenCount] = useState(0)
  const [runInputTokens, setRunInputTokens] = useState(0)
  const [runOutputTokens, setRunOutputTokens] = useState(0)
  // Token-Stand global broadcasten — die mobile Top-Bar hört zu und blendet ab 50% ein.
  useEffect(() => {
    if (!convIdState) return
    const fallback = engine === 'claude' ? 1_000_000 : 272_000
    const limit = contextWindow || fallback
    const pct = limit > 0 ? Math.min(Math.round((contextTokens / limit) * 100), 100) : 0
    window.dispatchEvent(new CustomEvent('deck:contextTokens', {
      detail: { convId: convIdState, tokens: contextTokens, limit, pct },
    }))
  }, [contextTokens, contextWindow, convIdState, engine])
  useEffect(() => {
    setRunTokenCount(0)
    setRunInputTokens(0)
    setRunOutputTokens(0)
  }, [convIdState])
  const [mobileRecording, setMobileRecording] = useState(false)
  const [mobilePaused, setMobilePaused] = useState(false)
  const [mobileTranscribing, setMobileTranscribing] = useState(false)

  // ── Global Audio Queue subscription ──
  const [aqState, setAqState] = useState(() => audioQueue.getState())
  useEffect(() => audioQueue.subscribe(setAqState), [])

  // Derive local playback state from global queue (only when this pane's conversation is playing)
  const isMyAudio = aqState.playingConversationId === convIdRef.current
  const playingTs = isMyAudio ? aqState.playingTs : 0
  const audioTime = isMyAudio ? aqState.audioTime : 0
  const audioDuration = isMyAudio ? aqState.audioDuration : 0
  const audioPaused = isMyAudio ? aqState.audioPaused : false

  const handleQuote = useCallback((text: string) => {
    const quoted = text.split('\n').map(l => `> ${l}`).join('\n')
    setQuoteText(`${quoted}\n\n`)
  }, [])

  const stopAudio = useCallback(() => {
    if (isMyAudio) audioQueue.stopCurrent()
  }, [isMyAudio])

  const toggleAudioPlayback = useCallback(() => {
    if (isMyAudio) audioQueue.togglePlayback()
  }, [isMyAudio])

  const seekAudio = useCallback((time: number) => {
    if (isMyAudio) audioQueue.seek(time)
  }, [isMyAudio])

  // Right Cmd or Escape stops audio
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.key === 'Meta' && e.location === 2) || (e.key === 'Escape' && aqState.playingTs)) {
        audioQueue.stopAll()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [aqState.playingTs])

  // Mobile recording dispatches this local event before getUserMedia starts.
  // Pane 0 owns the global stop listener so TTS dies immediately across chats.
  useEffect(() => {
    if (paneIndex !== 0) return
    const handler = () => audioQueue.stopAll()
    window.addEventListener('deck:stopAudio', handler)
    return () => window.removeEventListener('deck:stopAudio', handler)
  }, [paneIndex])

  /** Clean text for TTS — strip code, links, tables und Markdown-Markup, nur Fließtext übrig lassen. */
  const cleanForTTS = useCallback((text: string) => {
    if (!text) return ''
    let t = text
    // Sources-Block entfernen (Websuche-Fußnoten)
    t = t.replace(/\n?sources?:\s*\n(?:[ \t]*[-*][ \t]+[^\n]*\n?)*/gi, ' ')
    // Fenced & indented code blocks
    t = t.replace(/```[\s\S]*?```/g, ' ')
    t = t.replace(/~~~[\s\S]*?~~~/g, ' ')
    // Inline code
    t = t.replace(/`[^`\n]*`/g, ' ')
    // File paths: nur letztes Segment vorlesen, humanisiert (brain/ideas/foo-bar.md → Foo Bar in MD)
    t = t.replace(/(?<![:/])(?:[a-zA-Z0-9_.~-]+\/)+([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/g, (_, last) => {
      const dot = last.lastIndexOf('.')
      const base = dot > 0 ? last.slice(0, dot) : last
      const ext = dot > 0 ? last.slice(dot + 1).toUpperCase() : ''
      const words = base.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
      const humanized = words.replace(/\b\w/g, (c: string) => c.toUpperCase())
      return ext ? `${humanized} in ${ext}` : humanized
    })
    // Images ![alt](url)
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    // Markdown-Links [text](url) → text
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Reference-Links [text][ref] → text
    t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // Bare URLs (http/https/www)
    t = t.replace(/https?:\/\/\S+/gi, ' ')
    t = t.replace(/\bwww\.\S+/gi, ' ')
    // E-Mails
    t = t.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, ' ')
    // Tabellen: komplette Pipe-Zeilen raus
    t = t.replace(/^[ \t]*\|.*\|[ \t]*$/gm, '')
    // Tabellen-Separator |---|---|
    t = t.replace(/^[ \t]*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*[ \t]*$/gm, '')
    // Horizontale Linien
    t = t.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    // Heading-Marker
    t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    // Blockquote-Marker
    t = t.replace(/^[ \t]*>[ \t]?/gm, '')
    // Listenzeichen
    t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '')
    t = t.replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    // Bold / Italic / Strike — Marker entfernen, Inhalt behalten
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
    t = t.replace(/__([^_]+)__/g, '$1')
    t = t.replace(/\*([^*\n]+)\*/g, '$1')
    t = t.replace(/(?<![a-zA-Z0-9])_([^_\n]+)_(?![a-zA-Z0-9])/g, '$1')
    t = t.replace(/~~([^~]+)~~/g, '$1')
    // HTML-Tags (falls doch welche durchrutschen)
    t = t.replace(/<[^>]+>/g, ' ')
    // Restliche Markdown-Reste
    t = t.replace(/[|`]/g, ' ')
    t = t.replace(/\*+/g, '')
    t = t.replace(/(^|\s)_+(\s|$)/g, '$1$2')
    // Absatzwechsel zu Satzenden
    t = t.replace(/\n{2,}/g, '. ')
    t = t.replace(/\n/g, ' ')
    // Whitespace & Satzzeichen-Kosmetik
    t = t.replace(/[ \t]{2,}/g, ' ')
    t = t.replace(/(\.\s*){2,}/g, '. ')
    t = t.replace(/\s+([.,;:!?])/g, '$1')
    return t.trim()
  }, [])

  /**
   * Was vorgelesen wird: nur die finale Antwort-Prosa, nicht der Arbeitsweg.
   * Segmente werden an jedem Tool-Aufruf getrennt; das letzte nicht-leere
   * Segment ist der Text nach dem letzten Tool, also Christians "Fließtext".
   * Ohne Segmente (z. B. Cron-Ergebnis) bleibt der ganze Text.
   */
  const extractFinalProse = useCallback((text: string, segments?: string[]): string => {
    if (!text) return ''
    if (segments && segments.length > 1) {
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = (segments[i] || '').trim()
        if (seg) return seg
      }
    }
    return text
  }, [])

  /** Speak a message — manual click uses playNow (immediate), autoplay uses enqueue (sequential). */
  const speak = useCallback((text: string, agentName: string, ts?: number, opts?: { source?: string; segments?: string[] }) => {
    const source = extractFinalProse(text, opts?.segments)
    const clean = cleanForTTS(source)
    if (!clean) return
    const msgTs = ts || Date.now() / 1000
    const voiceId = localStorage.getItem('control:voice')
      || localStorage.getItem(`control:voice:${defaultAgent}`)
      || undefined
    let voiceSettings: audioQueue.SpeakRequest['voiceSettings']
    if (voiceId) {
      try {
        const raw = localStorage.getItem(`control:voiceSettings:${voiceId}`)
        if (raw) voiceSettings = JSON.parse(raw)
      } catch {}
    }
    const req: audioQueue.SpeakRequest = {
      text: clean,
      agentName,
      ts: msgTs,
      conversationId: convIdRef.current,
      source: opts?.source === 'autoplay' ? 'autoplay' : 'manual',
      voiceId: voiceId || undefined,
      voiceSettings,
    }
    if (opts?.source === 'autoplay') {
      audioQueue.enqueue(req)
    } else {
      audioQueue.playNow(req)
    }
  }, [cleanForTTS, defaultAgent, extractFinalProse])

  // Track text offset after last tool — text after this is the "final output" for TTS
  const lastToolTextOffsetRef = useRef(0)
  // Streaming TTS state — speak completed sentences as they arrive
  const ttsStreamOffsetRef = useRef(0)
  const ttsStreamAnyRef = useRef(false)
  const ttsStreamCounterRef = useRef(0)

  const flushSentenceTTSRef = useRef<(agentName: string, msgTs: number, final: boolean) => void>(() => {})
  // Live-Satz-TTS ist bewusst deaktiviert: einzelne Sätze sind fertig, bevor der
  // Tool-Event die Naht zum Arbeitsweg setzt, dadurch würde das "Selbstgespräch"
  // mitgesprochen. Der finalize-Pfad spricht am Stream-Ende nur die finale Prosa.
  // Funktion bleibt als No-op erhalten, damit bestehende Aufrufstellen tragen.
  const flushSentenceTTS = useCallback((_agentName: string, _msgTs: number, _final: boolean) => {
    return
  }, [])
  flushSentenceTTSRef.current = flushSentenceTTS

  // When agent finishes: autoplay the final output once.
  // Cron/result updates are already handled in the sync path above, so skip duplicate playback there.
  const prevBusyRef = useRef(false)
  useEffect(() => {
    if (prevBusyRef.current && !busy && autoplay && messages.length > 0) {
      const last = messages[messages.length - 1]
      const previous = messages.length > 1 ? messages[messages.length - 2] : null
      const alreadySpokenBySync = previous && last && previous.ts === last.ts
      if (!alreadySpokenBySync && last.bot && last.content && last.author !== 'System') {
        if (ttsStreamAnyRef.current) {
          // Streaming TTS already spoke earlier sentences — flush any unspoken tail and skip full speak.
          flushSentenceTTSRef.current(last.author, last.ts || Date.now() / 1000, true)
          ttsStreamAnyRef.current = false
          ttsStreamOffsetRef.current = 0
          ttsStreamCounterRef.current = 0
        } else {
          if (last.content.trim()) {
            speak(last.content, last.author, last.ts, { source: 'autoplay', segments: last.segments })
          }
        }
      }
    }
    prevBusyRef.current = busy
  }, [busy, autoplay, messages, speak])

  // Confirm-Haken: Erkennt, ob Agent gerade eine kurze Ja/Nein-Bestätigung erwartet.
  // Fällt zurück auf false, sobald der User wieder etwas sendet oder Agent weiterläuft.
  // Decline schickt keine Nachricht mehr — es markiert die aktuelle Confirm-Anfrage
  // einfach als verworfen, sodass der Haken verschwindet und Christian direkt weitersprechen kann.
  const [dismissedConfirmIdx, setDismissedConfirmIdx] = useState<number>(-1)
  const awaitingConfirmation = useMemo(() => {
    if (busy) return false
    if (queue.length > 0) return false
    if (messages.length === 0) return false
    if (dismissedConfirmIdx === messages.length - 1) return false
    const last = messages[messages.length - 1]
    if (!last || !last.bot || last.author === 'System' || !last.content) return false
    return detectConfirmationPrompt(last.content)
  }, [busy, queue.length, messages, dismissedConfirmIdx])

  const handleConfirm = useCallback(() => {
    if (busy) return
    send('Mach.')
  }, [busy, send])

  const handleDecline = useCallback(() => {
    setDismissedConfirmIdx(messages.length - 1)
  }, [messages.length])

  // ESC dismissed den Confirm-Haken (auch ohne dass Christian den X-Button trifft).
  useEffect(() => {
    if (!isActive) return
    if (!awaitingConfirmation) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      handleDecline()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isActive, awaitingConfirmation, handleDecline])

  const [chatDragging, setChatDragging] = useState(false)
  const dragDepthRef = useRef(0)
  const handlePaneDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types || !Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    dragDepthRef.current += 1
    setChatDragging(true)
  }, [])
  const handlePaneDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types || !Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])
  const handlePaneDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types || !Array.from(e.dataTransfer.types).includes('Files')) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setChatDragging(false)
  }, [])
  const handlePaneDrop = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    dragDepthRef.current = 0
    setChatDragging(false)
    if (!mobile && composerCollapsed) setMiniComposerOpen(true)
    window.dispatchEvent(new CustomEvent('deck:addFiles', { detail: { paneIndex, files: e.dataTransfer.files } }))
  }, [paneIndex, mobile, composerCollapsed])
  const dualPartner = engine === 'codex' ? 'Claude Code' : 'Codex'
  const dualSidecarRunning = activeTools.some(t => t.name === 'Agent' && String((t.input as Record<string, unknown> | undefined)?.mode || '') === 'dual')

  // Globaler Paste in der Chat-Pane: Bilder werden Anhaenge, Text wird in den Composer geschoben.
  // Wenn ein Input/Textarea/contenteditable den Fokus hat, ignorieren — der lokale
  // Composer-Paste uebernimmt dort.
  useEffect(() => {
    if (!isActive) return
    const handler = (e: ClipboardEvent) => {
      const ae = document.activeElement as HTMLElement | null
      const tag = ae?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || ae?.isContentEditable) return
      const cd = e.clipboardData
      if (!cd) return
      const items = cd.items
      const imageFiles: File[] = []
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) {
            const file = items[i].getAsFile()
            if (file) imageFiles.push(file)
          }
        }
      }
      if (imageFiles.length) {
        e.preventDefault()
        if (!mobile && composerCollapsed) setMiniComposerOpen(true)
        window.dispatchEvent(new CustomEvent('deck:addFiles', { detail: { paneIndex, files: imageFiles } }))
        return
      }
      const text = cd.getData('text/plain')
      if (!text) return
      e.preventDefault()
      if (!mobile && composerCollapsed) {
        setMiniComposerOpen(true)
        setMiniComposerText(prev => {
          const sep = prev && !prev.endsWith('\n') && !prev.endsWith(' ') ? ' ' : ''
          return prev + sep + text
        })
      } else {
        window.dispatchEvent(new CustomEvent('deck:appendText', { detail: { paneIndex, text } }))
      }
    }
    document.addEventListener('paste', handler)
    return () => document.removeEventListener('paste', handler)
  }, [paneIndex, mobile, composerCollapsed, isActive])

  return (
    <div
      className={`flex flex-col h-full min-h-0 relative`}
      data-agent-pane={agent}
      onClick={mobile ? undefined : () => onAgentFocus?.(agent)}
      onDragEnter={handlePaneDragEnter}
      onDragOver={handlePaneDragOver}
      onDragLeave={handlePaneDragLeave}
      onDrop={handlePaneDrop}
    >
      {chatDragging && (
        <div
          className="absolute inset-0 z-[60] flex items-center justify-center pointer-events-none animate-[fadeIn_0.12s_ease]"
          style={{
            background: 'color-mix(in srgb, var(--bg) 70%, transparent)',
            backdropFilter: 'blur(2px)',
          }}
        >
          <div
            className="px-5 py-3 rounded-2xl border border-dashed text-[16px] font-medium text-[var(--t1)]"
            style={{
              borderColor: 'var(--accent)',
              background: 'color-mix(in srgb, var(--bg-2) 92%, transparent)',
            }}
          >
            Datei hier ablegen, um sie anzuhängen
          </div>
        </div>
      )}
      {/* Mobile: Sheet wird über deck:openConvSheet vom globalen Top-Bar geöffnet */}
      {mobile && mobileConversations && onMobileConvChange && onMobileNewChat && onMobileRenameChat && onMobileArchiveChat && onMobileRestoreChat && onMobileLoadArchive && (
        <MobileChatSheet
          agent={agent}
          conversationId={externalConvId}
          conversations={mobileConversations}
          archivedChats={mobileArchivedChats || []}
          projects={mobileProjects || []}
          unreadConvs={mobileUnread || new Set()}
          busyConvs={mobileBusyConvs || new Set()}
          isActive={isActive}
          mobileSlotIndicator={mobileSlotIndicator}
          onConvChange={onMobileConvChange}
          onNewChat={onMobileNewChat}
          onRenameChat={onMobileRenameChat}
          onArchiveChat={onMobileArchiveChat}
          onRestoreChat={onMobileRestoreChat}
          onLoadArchive={onMobileLoadArchive}
        />
      )}
      {disconnected && !mobile && (
        <button
          onClick={() => location.reload()}
          className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[var(--bg-3)] text-[var(--t2)] text-sm cursor-pointer active:bg-[var(--bg-2)] transition-colors"
        >
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          Verbindung unterbrochen — verbinde neu…
        </button>
      )}
      <div className="flex-1 basis-0 min-h-0 overflow-hidden relative">
        <div className="h-full max-w-[720px] mx-auto px-6 max-md:px-0">
          {messages.length === 0 && !busy ? (
            <EmptyGreeting />
          ) : (
          <Chat
            messages={messages}
            activeTools={activeTools}
            thinkingText={phaseLabel ? `${phaseLabel}…` : thinkingText}
            streaming={busy}
            elapsedSeconds={elapsed}
            onQuote={handleQuote}
            onOpenRef={onOpenRef}
            onSpeak={(text, agent, ts) => {
              const msg = ts ? null : messages.find(m => m.content === text && m.author === agent)
              speak(text, agent, ts || msg?.ts)
            }}
            onResend={(text) => send(text)}
            onStop={() => handleCommand('/stop', '')}
            onEditMessage={async (id, content) => {
              try {
                const res = await fetch(`/api/messages/${id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ content }),
                })
                if (res.ok) {
                  setMessages(prev => prev.map(m => m.id === id ? { ...m, content, edited_at: Date.now() / 1000 } : m))
                }
              } catch {}
            }}
            onDeleteMessage={async (id) => {
              try {
                const res = await fetch(`/api/messages/${id}`, { method: 'DELETE' })
                if (res.ok) {
                  setMessages(prev => prev.filter(m => m.id !== id))
                }
              } catch {}
            }}
            playingTs={playingTs}
            scrollTrigger={scrollTrigger}
            layoutTrigger={layoutTrigger}
            mobile={mobile}
            visualFinalizeKey={visualFinalizeKey}
            visualFinalizeToken={visualFinalizeToken || undefined}
            onVisualComplete={handleVisualComplete}
            onNearBottomChange={mobile ? setIndicatorVisible : undefined}
          />
          )}
        </div>
        {/* Slot-Indicator lebt jetzt im Composer (Tools-Row rechts), nicht mehr als floating overlay. */}
      </div>

      {!mobile && (() => {
        let lastBot: typeof messages[number] | undefined
        for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].bot) { lastBot = messages[i]; break } }
        const storedInputTokens = visibleTokenPart(lastBot?.inputTokens)
        const storedOutputTokens = visibleTokenPart(lastBot?.outputTokens)
        const shownInputTokens = runInputTokens || storedInputTokens
        const shownOutputTokens = runOutputTokens || storedOutputTokens
        const shownTokenCount = runTokenCount || shownInputTokens + shownOutputTokens
        return (
          <PaneLiveFooter
            busy={busy}
            elapsedSeconds={elapsed}
            statusLabel={phaseLabel || thinkingText}
            tools={lastBot?.tools || []}
            doneMs={lastBot ? (lastBot.elapsedMs ?? Math.round(elapsed * 1000)) : null}
            tokenCount={shownTokenCount}
            inputTokens={shownInputTokens}
            outputTokens={shownOutputTokens}
            queueItems={queue.map(q => ({ id: q.id, text: q.text }))}
            onRemoveQueueItem={removeFromQueue}
            onMoveQueueItem={moveInQueue}
            onClearQueue={clearQueue}
            werkbankTasks={werkbankTasks}
            onStop={() => handleCommand('/stop', '')}
            paneSwitcher={paneSwitcher}
          />
        )
      })()}

      {!mobile && composerCollapsed && (
        <div className="absolute bottom-[calc(var(--header-row-h)+0.9rem)] left-0 right-0 z-30 animate-[fadeIn_0.15s_ease] pointer-events-none px-6">
          <div className="mx-auto flex w-full max-w-[720px] min-w-0 items-center justify-end gap-2">
            {pendingAttachments.length > 0 && !miniComposerOpen && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setMiniComposerOpen(true) }}
              className="pointer-events-auto flex min-w-0 items-center gap-1.5 h-10 rounded-full bg-[var(--bg-2)] border border-[var(--border-f)] pl-1.5 pr-3 hover:bg-[var(--bg-3)] transition-colors cursor-pointer max-w-[260px]"
              title={`${pendingAttachments.length} ${pendingAttachments.length === 1 ? 'Anhang' : 'Anhänge'} · Eingabe öffnen`}
              aria-label={`${pendingAttachments.length} Anhänge, Eingabe öffnen`}
            >
              <div className="flex items-center -space-x-1.5">
                {pendingAttachments.slice(0, 3).map((a, i) => (
                  a.preview || (a.type?.startsWith('image/') && a.url) ? (
                    <img
                      key={i}
                      src={a.preview || a.url}
                      alt=""
                      className="w-7 h-7 rounded-full object-cover border-2 border-[var(--bg-2)]"
                    />
                  ) : (
                    <div
                      key={i}
                      className="w-7 h-7 rounded-full bg-[var(--bg-3)] border-2 border-[var(--bg-2)] flex items-center justify-center text-[var(--t3)]"
                    >
                      <FileText className="w-3.5 h-3.5" />
                    </div>
                  )
                ))}
              </div>
              <span className="text-[14px] text-[var(--t2)] tabular-nums">
                {pendingAttachments.length > 3 ? `+${pendingAttachments.length - 3}` : pendingAttachments.length === 1 ? '1 Anhang' : `${pendingAttachments.length} Anhänge`}
              </span>
            </button>
          )}
          {!!playingTs && !miniComposerOpen ? (
            <div
              className="chatpane-audio-player pointer-events-auto flex h-9 w-full min-w-0 items-center rounded-full bg-[var(--bg-2)] border border-[var(--border-f)] text-[var(--t2)]"
              onClick={e => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleAudioPlayback() }}
                className="chatpane-audio-button flex flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-white transition-colors cursor-pointer"
                title={audioPaused ? 'Weiter' : 'Pause'}
                aria-label={audioPaused ? 'Weiter' : 'Pause'}
              >
                {audioPaused
                  ? <Play className="w-3.5 h-3.5" fill="currentColor" style={{ marginLeft: 1 }} />
                  : <Pause className="w-3.5 h-3.5" fill="currentColor" />
                }
              </button>
              <input
                type="range"
                min={0}
                max={audioDuration || 0}
                step={0.1}
                value={Math.min(audioTime, audioDuration || audioTime || 0)}
                onChange={e => seekAudio(Number(e.target.value))}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
                className="audio-scrubber chatpane-audio-scrubber min-w-0 flex-1"
                style={{ ['--pct' as string]: `${audioDuration > 0 ? Math.min(100, (audioTime / audioDuration) * 100) : 0}%` }}
                aria-label="Audio-Position"
              />
              <span className="chatpane-audio-time flex-shrink-0 tabular-nums text-[var(--t3)]" aria-label={`Audiozeit ${formatAudioTime(audioTime)} von ${formatAudioTime(audioDuration)}`}>
                {formatAudioTime(audioTime)}/{formatAudioTime(audioDuration)}
              </span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); stopAudio() }}
                className="chatpane-audio-button flex flex-shrink-0 items-center justify-center rounded-full text-[var(--t3)] hover:text-[var(--t1)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer"
                title="Audio stoppen"
                aria-label="Audio stoppen"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : busy && !miniComposerOpen ? (
            <div
              className="pointer-events-auto relative flex h-10 items-stretch rounded-full bg-[var(--bg-2)] border border-[var(--border-f)] transition-opacity duration-200 opacity-0 hover:opacity-100 focus-within:opacity-100"
            >
              <button
                onClick={(e) => { e.stopPropagation(); setMiniComposerOpen(true) }}
                className="flex h-full w-10 items-center justify-center rounded-full text-[var(--t2)] hover:text-[var(--t1)] hover:bg-[var(--bg-3)] transition-all cursor-pointer"
                title="Eingabe öffnen"
                aria-label="Eingabe öffnen"
              >
                <Plus className="w-5 h-5" />
              </button>
            </div>
          ) : (
            <div
              className={`pointer-events-auto relative flex h-10 items-center rounded-full bg-[var(--bg-2)] border border-[var(--border-f)] text-[var(--t2)] transition-all duration-200 overflow-hidden ${
                miniComposerOpen ? 'w-full' : 'w-10'
              } ${
                miniComposerOpen ? 'opacity-100' : 'opacity-0 hover:opacity-100 focus-within:opacity-100'
              }`}
            >
              {miniComposerOpen ? (
                <>
                  <input
                    ref={miniComposerFileInputRef}
                    type="file"
                    multiple
                    accept={COMPOSER_FILE_ACCEPT}
                    className="hidden"
                    onChange={e => {
                      if (e.target.files?.length) {
                        window.dispatchEvent(new CustomEvent('deck:addFiles', { detail: { paneIndex, files: e.target.files } }))
                        e.target.value = ''
                        setMiniComposerOpen(true)
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      miniComposerFileInputRef.current?.click()
                    }}
                    className="flex h-full w-10 flex-shrink-0 items-center justify-center text-[var(--t3)] hover:text-[var(--t1)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer"
                    title="Datei anhängen"
                    aria-label="Datei anhängen"
                  >
                    <Paperclip className="w-[20px] h-[20px]" strokeWidth={1.8} />
                  </button>
                  <input
                    ref={miniComposerInputRef}
                    value={miniComposerText}
                    onChange={e => setMiniComposerText(e.target.value)}
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        sendMiniComposer()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        if (!miniComposerText.trim()) setMiniComposerOpen(false)
                      }
                    }}
                    placeholder="Nachricht einfügen..."
                    className="min-w-0 flex-1 bg-transparent border-0 outline-none text-[15px] text-[var(--t1)] placeholder:text-[var(--t3)]/65"
                    aria-label="Nachricht an Agent"
                  />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      void pasteIntoMiniComposer()
                    }}
                    className="flex h-full w-9 flex-shrink-0 items-center justify-center text-[var(--t3)] hover:text-[var(--t1)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer"
                    title="Zwischenablage einfügen"
                    aria-label="Zwischenablage einfügen"
                  >
                    <ClipboardPaste className="w-[19px] h-[19px]" strokeWidth={1.9} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (miniComposerText.trim() || pendingAttachments.length > 0) sendMiniComposer()
                      else setMiniComposerOpen(false)
                    }}
                    className="flex h-full w-10 flex-shrink-0 items-center justify-center text-[var(--t1)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer"
                    title={miniComposerText.trim() || pendingAttachments.length > 0 ? 'Senden' : 'Schließen'}
                    aria-label={miniComposerText.trim() || pendingAttachments.length > 0 ? 'Senden' : 'Schließen'}
                  >
                    {miniComposerText.trim() || pendingAttachments.length > 0
                      ? <ArrowUp className="w-[20px] h-[20px]" strokeWidth={2.25} />
                      : <X className="w-[20px] h-[20px]" strokeWidth={2} />
                    }
                  </button>
                </>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); setMiniComposerOpen(true) }}
                  className="flex h-10 w-10 items-center justify-center text-[var(--t2)] hover:text-[var(--t1)] hover:bg-[var(--bg-3)] transition-all cursor-pointer"
                  title="Eingabe öffnen"
                  aria-label="Eingabe öffnen"
                >
                  <Plus className="w-5 h-5" />
                </button>
              )}
            </div>
          )}
          </div>
        </div>
      )}
      <div
        className={mobile ? "w-full bg-transparent relative z-[50]" : "max-w-[720px] mx-auto w-full px-2 max-md:px-1 bg-[var(--bg)] relative z-10"}
        style={{
          ...(mobile ? { paddingBottom: 0 } : { marginTop: '-3px' }),
          ...(!mobile && composerCollapsed ? { display: 'none' } : {}),
        }}
      >
        {!mobile && (
          <button
            onClick={(e) => { e.stopPropagation(); setComposerCollapsed(true) }}
            className="absolute top-3 right-4 z-20 flex h-6 w-6 items-center justify-center rounded-full text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer transition-colors"
            title="Composer minimieren"
            aria-label="Composer minimieren"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {/* Status sitzt in beiden Modi IM Composer (siehe Composer.tsx). */}
        {mobile && disconnected && (
          <button
            onClick={() => location.reload()}
            className="w-full flex items-center justify-center gap-2 px-4 py-1.5 text-[var(--t3)] text-[14px] cursor-pointer active:text-[var(--t2)] transition-colors"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            Verbindung unterbrochen — verbinde neu…
          </button>
        )}
        {/* Queue UI */}
        {queue.length > 0 && (
          <div className={mobile ? "px-5 mb-1.5" : "px-4 max-md:px-3 mb-2"}>
            <div className="flex flex-col gap-1">
              {queue.map((item, idx) => (
                <div key={item.id} className={`flex items-center gap-2 bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-3 group animate-[fadeIn_0.15s_ease] ${mobile ? 'py-2.5' : 'py-1.5'}`}>
                  <span className={`text-[var(--t3)] font-medium w-4 text-center flex-shrink-0 ${mobile ? 'text-[16px]' : 'text-[13px]'}`}>{idx + 1}</span>
                  <span className={`text-[var(--t2)] truncate flex-1 ${mobile ? 'text-[18px]' : 'text-[15px]'}`}>{item.text}</span>
                  {item.attachments?.length ? <span className={`text-[var(--t3)] ${mobile ? 'text-[16px]' : 'text-[13px]'}`}>+{item.attachments.length}</span> : null}
                  <div className={`flex items-center gap-0.5 ${mobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
                    {idx > 0 && (
                      <button onClick={() => moveInQueue(item.id, -1)} className={`text-[var(--t3)] active:text-[var(--t2)] cursor-pointer transition-colors ${mobile ? 'p-1.5' : 'p-0.5 hover:text-[var(--t2)]'}`}>
                        <ChevronUp className={mobile ? "w-5 h-5" : "w-3.5 h-3.5"} />
                      </button>
                    )}
                    {idx < queue.length - 1 && (
                      <button onClick={() => moveInQueue(item.id, 1)} className={`text-[var(--t3)] active:text-[var(--t2)] cursor-pointer transition-colors ${mobile ? 'p-1.5' : 'p-0.5 hover:text-[var(--t2)]'}`}>
                        <ChevronDownIcon className={mobile ? "w-5 h-5" : "w-3.5 h-3.5"} />
                      </button>
                    )}
                    <button onClick={() => removeFromQueue(item.id)} className={`text-[var(--t3)] active:text-red-400 cursor-pointer transition-colors ${mobile ? 'p-1.5' : 'p-0.5 hover:text-red-400'}`}>
                      <X className={mobile ? "w-5 h-5" : "w-3.5 h-3.5"} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <Composer
          model={model}
          busy={busy}
          elapsed={elapsed}
          busyKind={busy ? (activeTools.length > 0 ? 'tool' : thinkingText ? 'thinking' : 'writing') : (elapsed > 0 ? 'done' : 'idle')}
          busyAgent={cfg?.name}
          agent={agent}
          engine={engine}
          project={project}
          chatTitle={(() => {
            const cid = externalConvId || convIdState
            if (!cid || !mobileConversations) return ''
            return mobileConversations.find(c => c.id === cid)?.title || ''
          })()}
          quoteText={quoteText}
          onQuoteConsumed={() => setQuoteText('')}
          onAgentChange={handleAgentChange}
          onProjectChange={handleProjectChange}
          onSend={busy ? enqueue : send}
          onCommand={handleCommand}
          disabled={false}
          effort={effort}
          onEffortChange={(level) => {
            setEffort(level)
            const cid = externalConvId || convIdState || convIdRef.current
            if (cid) {
              localStorage.setItem(`control:effort:conv:${cid}`, level)
              fetch(`/api/conversations/${cid}/prefs`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ effort: level, source: mobile ? 'mobile' : 'desktop' }),
              }).catch(() => {})
            }
            // Agent-Default mitschreiben, damit neue leere Chats die letzte Wahl erben.
            localStorage.setItem(`control:effort:${defaultAgent}`, level)
          }}
          onEngineChange={(next) => {
            setEngine(next)
            setModel(defaultModelForEngine(next))
            // Codex kennt nur low/medium/high — wenn aktueller Wert höher ist, auf high cappen.
            if (next === 'codex' && (effort === 'xhigh' || effort === 'max')) {
              setEffort('high')
              localStorage.setItem(`control:effort:${defaultAgent}`, 'high')
              const cid0 = externalConvId || convIdState || convIdRef.current
              if (cid0) {
                fetch(`/api/conversations/${cid0}/prefs`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ effort: 'high', source: mobile ? 'mobile' : 'desktop' }),
                }).catch(() => {})
              }
            }
            const cid = externalConvId || convIdState || convIdRef.current
            if (cid && !cid.startsWith('channel-')) {
              fetch(`/api/conversations/${cid}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ engine: next }),
              }).catch(() => {})
            }
            try { localStorage.setItem('control:engine:default', next) } catch {}
          }}
          onModelChange={(next) => {
            setModel(next)
            const cid = externalConvId || convIdState || convIdRef.current
            if (cid && !cid.startsWith('channel-')) {
              fetch(`/api/conversations/${cid}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: next }),
              }).catch(() => {})
            }
          }}
          deepMode={deepMode}
          onDeepToggle={() => setDeepMode(v => {
            const next = !v
            const cid = externalConvId || convIdState || convIdRef.current
            if (cid) {
              localStorage.setItem(`control:deepMode:conv:${cid}`, String(next))
              fetch(`/api/conversations/${cid}/prefs`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deepMode: next, source: mobile ? 'mobile' : 'desktop' }),
              }).catch(() => {})
            }
            localStorage.setItem(`control:deepMode:${defaultAgent}`, String(next))
            return next
          })}
          dualMode={dualMode}
          dualPartner={dualPartner}
          dualRunning={dualSidecarRunning}
          onDualToggle={() => {
            const next = !dualMode
            setDualMode(next)
            const cid = externalConvId || convIdState || convIdRef.current
            if (cid) {
              localStorage.setItem(`control:dualMode:conv:${cid}`, String(next))
              fetch(`/api/conversations/${cid}/prefs`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dualMode: next, source: mobile ? 'mobile' : 'desktop' }),
              }).catch(() => {})
            }
            localStorage.setItem(`control:dualMode:${defaultAgent}`, String(next))
          }}
          contextTokens={contextTokens}
          contextWindow={contextWindow}
          onStopAudio={stopAudio}
          isPlaying={!!playingTs}
          audioTime={audioTime}
          audioDuration={audioDuration}
          audioPaused={audioPaused}
          onAudioPlayPause={toggleAudioPlayback}
          onAudioSeek={seekAudio}
          mobile={mobile}
          mobileRecording={mobileRecording}
          mobilePaused={mobilePaused}
          mobileTranscribing={mobileTranscribing}
          onMobileRecord={() => { if (autoplay) audioQueue.warmUp(); window.dispatchEvent(new CustomEvent('deck:toggleRecord', { detail: { agentId: agent } })) }}
          onMobileCancelRecord={() => window.dispatchEvent(new CustomEvent('deck:recordCancel'))}
          onMobilePauseRecord={() => window.dispatchEvent(new CustomEvent('deck:recordPause'))}
          onMobileResumeRecord={() => window.dispatchEvent(new CustomEvent('deck:recordResume'))}
          onStartVoice={onStartVoice ? () => onStartVoice(convIdRef.current || effectiveChannelId, agent) : undefined}
          voiceReady={voiceReady}
          isActive={isActive}
          draftKey={convIdState || effectiveChannelId}
          paneIndex={paneIndex}
          awaitingConfirmation={awaitingConfirmation}
          onConfirm={handleConfirm}
          onDecline={handleDecline}
          mobileSlotIndicator={mobileSlotIndicator}
          infoPaneOpen={infoPaneOpen}
        />
      </div>
    </div>
  )
}

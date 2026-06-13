import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, Square, X, Plus, Paperclip, FileText, Image, Mic, Play, Pause, Lightbulb, Brain, Settings as SettingsIcon, Trash2, Hourglass, Check, Keyboard, ChevronDown, MessagesSquare, Inbox, Search, RotateCw, Target, MonitorSmartphone, HeartPulse, ClipboardPaste, PhoneOff, Sun, Moon, Hammer } from 'lucide-react'
import { getThemeMode, setThemeMode, resolveTheme } from '../theme'
import { getAgents, useMainAgentName, ownerFirstName, type Engine } from '../agents'
import { useVoiceState, type VoiceState } from './voiceState'
import KlausVoiceOrb from './KlausVoiceOrb'
import { playUISound } from '../uiSounds'
import { triggerSafeRestart } from '../lib/restart'
import { SLASH_COMMANDS, matchEngine, type SlashCommand } from '../slashCommands'
import { useWerkbankNavSignal } from '../workspace/werkbankSignal'
import { INBOX_SEEN_CHANGED_EVENT, hasUnseenInboxWaiting, inboxMailWaitingKey, inboxWaWaitingKey, markInboxWaitingSeen } from '../inboxSeen'

type KlausMood =
  | 'idle'
  | 'sleepy'
  | 'peek-right'
  | 'peek-left'
  | 'peek-up'
  | 'peek-down'
  | 'wink'
  | 'nod'
  | 'shake'
  | 'angry'
  | 'surprised'
  | 'squint'

function voiceClass(v: VoiceState): string {
  if (!v.active || v.phase !== 'live') return ''
  if (v.isMuted) return 'voice-muted'
  if (v.isThinking) return 'voice-thinking'
  if (v.isSpeaking) return 'voice-speaking'
  return 'voice-listening'
}

// Flanger-Zustand für die Bars: connecting → thinking → speaking → listening.
// Treibt die .voice-bars--*-Klassen (Farbe + Animation pro Zustand).
function voiceBarsState(v: VoiceState): 'connecting' | 'thinking' | 'speaking' | 'listening' {
  if (v.phase === 'connecting' || v.phase === 'init') return 'connecting'
  if (v.isThinking) return 'thinking'
  if (v.isSpeaking) return 'speaking'
  return 'listening'
}

// Fünf-Bar-Equalizer als Voice-Indikator. Ersetzt im aktiven Voice-Modus das
// statische Mic-Icon: grau-atmend beim Zuhören, orange-pumpend beim Reden,
// teal-wellig beim Nachdenken, dezenter Puls beim Verbinden.
function VoiceBars({ state, lg }: { state: VoiceState; lg?: boolean }) {
  return (
    <span className={`voice-bars${lg ? ' voice-bars--lg' : ''} voice-bars--${voiceBarsState(state)}`} aria-hidden>
      <span className="voice-bar" />
      <span className="voice-bar" />
      <span className="voice-bar" />
      <span className="voice-bar" />
      <span className="voice-bar" />
    </span>
  )
}

const AGENTS = getAgents().filter(a => !a.sub).map(a => ({ id: a.id, name: a.name }))


export interface Attachment {
  name: string
  url: string
  type: string
  size: number
  preview?: string  // data URL for image preview before upload
  uploading?: boolean
  file?: File
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function uploadFile(file: File): Promise<Attachment> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/upload', { method: 'POST', body: form })
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || 'Upload fehlgeschlagen')
  return { name: data.name, url: data.url, type: data.type, size: data.size }
}

const AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.ogg', '.wav', '.webm', '.flac', '.aac'])
function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
  return AUDIO_EXTENSIONS.has(ext)
}

type WaStatusChat = {
  id?: string
  last_ts?: number | null
  triage?: string | null
  is_archived?: boolean
  unread?: number
}


type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// Codex CLI kennt nur drei Reasoning-Stufen (--reasoning-effort low|medium|high).
// Claude bietet zusätzlich xhigh und max. Dropdown filtert pro Engine.
const EFFORT_LEVELS_BY_ENGINE: Record<Engine, readonly Effort[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high'],
}

const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Niedrig',
  medium: 'Mittel',
  high: 'Hoch',
  xhigh: 'Sehr hoch',
  max: 'Maximum',
}

// Engine-Logos (offizielle Marken-Pfade, monochrom via currentColor) — Größe per `size`.
function ClaudeCodeLogo({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" fillRule="evenodd" clipRule="evenodd" aria-hidden="true">
      <path d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" />
    </svg>
  )
}

function CodexLogo({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" fillRule="evenodd" clipRule="evenodd" aria-hidden="true">
      <path d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" />
    </svg>
  )
}

function EngineLogo({ engine, size = 18 }: { engine: Engine; size?: number }) {
  return engine === 'claude' ? <ClaudeCodeLogo size={size} /> : <CodexLogo size={size} />
}

function effortBrainStyle(effort: Effort): { color: string; fill: string; strokeWidth: number } {
  switch (effort) {
    case 'low':    return { color: 'var(--t3)',   fill: 'none', strokeWidth: 1.75 }
    case 'medium': return { color: 'var(--t2)',   fill: 'none', strokeWidth: 1.75 }
    case 'high':   return { color: 'var(--t1)',   fill: 'none', strokeWidth: 1.75 }
    case 'xhigh':  return { color: '#ffffff',     fill: 'none', strokeWidth: 1.75 }
    case 'max':    return { color: '#d97757',     fill: 'none', strokeWidth: 1.75 }
  }
}

interface Props {
  agent: string
  engine: Engine
  project: string
  model: string
  busy: boolean
  elapsed: number
  /** Aggregierter Status: tool/thinking/writing während Arbeit, done direkt danach, sonst idle. */
  busyKind?: 'tool' | 'thinking' | 'writing' | 'done' | 'idle'
  quoteText?: string
  onQuoteConsumed?: () => void
  onAgentChange: (id: string) => void
  onProjectChange: (path: string) => void
  onSend: (text: string, context?: string, attachments?: Attachment[]) => void
  onCommand?: (cmd: string, args: string) => void
  disabled?: boolean
  effort?: Effort
  onEffortChange?: (level: Effort) => void
  onEngineChange?: (engine: Engine) => void
  onModelChange?: (model: string) => void
  deepMode?: boolean
  onDeepToggle?: () => void
  dualMode?: boolean
  dualPartner?: string
  dualRunning?: boolean
  onDualToggle?: () => void
  busyAgent?: string
  contextTokens?: number
  contextWindow?: number
  onStopAudio?: () => void
  isPlaying?: boolean
  audioTime?: number
  audioDuration?: number
  onAudioPlayPause?: () => void
  onAudioSeek?: (time: number) => void
  audioPaused?: boolean
  mobile?: boolean
  mobileRecording?: boolean
  mobilePaused?: boolean
  mobileTranscribing?: boolean
  onMobileRecord?: () => void
  onMobileCancelRecord?: () => void
  onMobilePauseRecord?: () => void
  onMobileResumeRecord?: () => void
  onOpenSettings?: () => void
  onStartVoice?: () => void
  voiceReady?: boolean
  isActive?: boolean
  /** Stabile Kennung pro Chat — speichert Entwurf in localStorage, bleibt beim Pane-Wechsel erhalten. */
  draftKey?: string
  /** Pane-Index — auf Mobile genutzt, damit Voice-Send Anhänge der richtigen Pane mitnehmen kann. */
  paneIndex?: number
  /** Wenn true, blendet einen sanft pulsierenden Bestätigungs-Haken neben Send ein. */
  awaitingConfirmation?: boolean
  onConfirm?: () => void
  onDecline?: () => void
  /** Slot-Pillen-Indicator (Mobile). Wird rechts oben in der Composer-Tools-Row gerendert. */
  mobileSlotIndicator?: React.ReactNode
  /** Mobile: signalisiert dem Composer, dass das InfoPane gerade als Overlay offen ist —
      der Hamburger-Slot wird zum Schließen-Button. */
  infoPaneOpen?: boolean
  /** Aktueller Chat-Titel — wird im Plus-Menü als Header gezeigt, damit klar ist, wo wir gerade sind. */
  chatTitle?: string
}

// Fallback-Contextfenster pro Engine, solange das Backend noch kein contextWindow
// im Event mitgeschickt hat (z.B. vor dem ersten Send in einer frischen Conversation).
// Die eigentlichen Limits werden vom Backend pro turn.completed mitgesendet.
// Auswählbare Claude-Modelle im Composer-Menü (nur bei Engine=claude).
const CLAUDE_MODEL_OPTIONS: { id: string; name: string }[] = [
  { id: 'claude-opus-4-8', name: 'Opus 4.8' },
  { id: 'claude-fable-5', name: 'Fable 5' },
]
function claudeModelLabel(m: string): string {
  const hit = CLAUDE_MODEL_OPTIONS.find(x => x.id === m || x.name === m)
  return hit ? hit.name : m
}

function defaultContextWindow(engine: Engine): number {
  return engine === 'claude' ? 1_000_000 : 272_000
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  return `${Math.round(tokens / 1000)}K`
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

const MOBILE_VOICE_FIRST_KEY = 'mobile:voiceFirst'
const MOBILE_VOICE_FIRST_SYNC_EVENT = 'deck:mobileVoiceFirst'
const MOBILE_MENU_LINE_KEY = 'mobile:menuLine:v3'

// Eleganter Hell/Dunkel-Switch fuers mobile Menue: gleitender Daumen von Sonne
// zu Mond. Gekapselt — liest/schreibt den globalen Theme-State selbst.
function MobileThemeToggle() {
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(getThemeMode()))
  useEffect(() => {
    const sync = () => setResolved(resolveTheme(getThemeMode()))
    window.addEventListener('theme-changed', sync)
    return () => window.removeEventListener('theme-changed', sync)
  }, [])
  const toggle = () => {
    const next = resolved === 'dark' ? 'light' : 'dark'
    playUISound('option-pick', 0.4)
    setResolved(next)
    setThemeMode(next)
  }
  const isDark = resolved === 'dark'
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); toggle() }}
      className="mobile-theme-toggle"
      data-dark={isDark ? 'true' : 'false'}
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? 'Auf Hell umschalten' : 'Auf Dunkel umschalten'}
      title={isDark ? 'Hell' : 'Dunkel'}
    >
      <span className="mtt-icon mtt-sun"><Sun className="w-[17px] h-[17px]" strokeWidth={1.9} /></span>
      <span className="mtt-icon mtt-moon"><Moon className="w-[17px] h-[17px]" strokeWidth={1.9} /></span>
      <span className="mtt-thumb" aria-hidden />
    </button>
  )
}

type MobileMenuBriefingPayload = {
  calendar_today?: string[]
  calendar_tomorrow?: string[]
  pt_today?: string[]
  pt_tomorrow?: string[]
  slots_today?: string[]
  slots_tomorrow?: string[]
  waiting_on_you?: string[]
  lead_pipeline?: string[]
  overdue_slots?: Array<{ title?: string | null }>
  counts?: Record<string, number>
}

type MobileMenuLineCache = {
  day: string
  signature: string
  line: string
}

function localDayKey(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function dayPhase(now = new Date()): 'morning' | 'day' | 'late' | 'evening' | 'night' {
  const hour = now.getHours()
  if (hour < 10) return 'morning'
  if (hour < 16) return 'day'
  if (hour < 19) return 'late'
  if (hour < 23) return 'evening'
  return 'night'
}

function hashText(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  return Math.abs(hash)
}

function pickLine(lines: string[], seed: string): string {
  return lines[hashText(seed) % lines.length]
}

function mobileMenuGreeting(phase: ReturnType<typeof dayPhase>, seed: string): string {
  // Anrede mit dem Inhaber-Vornamen aus config/agents.json. Ohne gesetzten
  // Namen fallen die personalisierten Varianten weg, der Rest bleibt neutral.
  const name = ownerFirstName().trim()
  const named = (greeting: string) => name ? greeting.replace('{name}', name) : ''
  const greetings = phase === 'morning'
    ? ['', 'Moin,', named('Moin {name},'), 'Hey,']
    : phase === 'evening' || phase === 'night'
      ? ['', named('Naabend {name},'), 'Guten Abend,', 'Hey mein Lieber,']
      : ['', named('Hey {name},'), 'Hey,', 'Na mein Lieber,']
  return pickLine(greetings.filter((g, i) => i === 0 || g !== ''), `${seed}:greeting`)
}

function menuLineWithGreeting(lines: string[], seed: string, phase: ReturnType<typeof dayPhase>): string {
  const line = pickLine(lines, seed)
  const greeting = mobileMenuGreeting(phase, seed)
  return greeting ? `${greeting} ${line}` : line
}

function briefingCount(payload: MobileMenuBriefingPayload | null | undefined, key: keyof MobileMenuBriefingPayload): number {
  const value = payload?.[key]
  if (Array.isArray(value)) return value.length
  const count = payload?.counts?.[String(key)]
  return Number.isFinite(count) ? Number(count) : 0
}

function mobileMenuSignature(payload: MobileMenuBriefingPayload | null | undefined, now = new Date()): string {
  const keys: Array<keyof MobileMenuBriefingPayload> = [
    'calendar_today',
    'calendar_tomorrow',
    'pt_today',
    'pt_tomorrow',
    'slots_today',
    'slots_tomorrow',
    'waiting_on_you',
    'lead_pipeline',
    'overdue_slots',
  ]
  const counts = keys.map(key => `${String(key)}:${briefingCount(payload, key)}`).join('|')
  const firstSignals = [
    payload?.calendar_today?.[0],
    payload?.slots_today?.[0],
    payload?.waiting_on_you?.[0],
    payload?.lead_pipeline?.[0],
    payload?.overdue_slots?.[0]?.title,
  ].filter(Boolean).join('|')
  return `${localDayKey(now)}|${dayPhase(now)}|${counts}|${firstSignals}`
}

function buildMobileMenuLine(payload?: MobileMenuBriefingPayload | null, now = new Date()): string {
  const phase = dayPhase(now)
  const seed = mobileMenuSignature(payload, now)
  const todayBusy = briefingCount(payload, 'calendar_today') + briefingCount(payload, 'pt_today') + briefingCount(payload, 'slots_today')
  const tomorrowBusy = briefingCount(payload, 'calendar_tomorrow') + briefingCount(payload, 'pt_tomorrow') + briefingCount(payload, 'slots_tomorrow')
  const waiting = briefingCount(payload, 'waiting_on_you')
  const leads = briefingCount(payload, 'lead_pipeline')
  const overdue = briefingCount(payload, 'overdue_slots')

  if (overdue > 0) {
    return menuLineWithGreeting([
      'ein Punkt will noch raus.',
      'erst den kleinen Knoten lösen.',
      'ein offener Punkt reicht.',
    ], seed, phase)
  }
  if ((phase === 'evening' || phase === 'night') && tomorrowBusy > 0) {
    return menuLineWithGreeting([
      'morgen steht, heute ruhig schließen.',
      'morgen ist voll, heute leise.',
      'heute nichts Großes mehr aufmachen.',
    ], seed, phase)
  }
  if (waiting > 0) {
    return menuLineWithGreeting([
      'eine Antwort macht heute Luft.',
      'kurz klären, dann ist Ruhe.',
      'der offene Faden reicht.',
    ], seed, phase)
  }
  if (leads > 0) {
    return menuLineWithGreeting([
      'erst sortieren, dann antworten.',
      'neue Bewegung, ruhig bleiben.',
      'ein Faden, kein Druck.',
    ], seed, phase)
  }
  if (todayBusy > 0 && phase !== 'evening' && phase !== 'night') {
    return menuLineWithGreeting([
      'beim nächsten Block bleiben.',
      'heute einfach sauber weiter.',
      'ein Termin nach dem anderen.',
    ], seed, phase)
  }
  if (phase === 'morning') {
    return menuLineWithGreeting([
      'ruhig starten, klar werden.',
      'erst Überblick, dann Tempo.',
      'heute gut, nicht voll.',
    ], seed, phase)
  }
  if (phase === 'evening' || phase === 'night') {
    return menuLineWithGreeting([
      'nur noch weich abschließen.',
      'der Abend darf leiser werden.',
      'nichts Großes mehr aufmachen.',
    ], seed, phase)
  }
  return menuLineWithGreeting([
    'ruhig bleiben, nächster Schritt.',
    'klarer werden, nicht größer.',
    'ein Schritt reicht gerade.',
  ], seed, phase)
}

function readMobileMenuLineCache(now = new Date()): MobileMenuLineCache | null {
  try {
    const raw = localStorage.getItem(MOBILE_MENU_LINE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as MobileMenuLineCache
    if (parsed?.day !== localDayKey(now) || !parsed.line) return null
    return parsed
  } catch {
    return null
  }
}

function initialMobileMenuLine(): string {
  return readMobileMenuLineCache()?.line || buildMobileMenuLine(null)
}

export function Composer({ agent: _agent, engine, project: _project, model, busy, elapsed, busyKind = 'idle', quoteText, onQuoteConsumed, onAgentChange, onProjectChange: _onProjectChange, onSend, onCommand, disabled, effort = 'medium', onEffortChange, onEngineChange, onModelChange, deepMode, onDeepToggle, dualMode = false, dualPartner = '', dualRunning = false, onDualToggle, busyAgent: _busyAgent, contextTokens = 0, contextWindow = 0, onStopAudio, isPlaying, audioTime = 0, audioDuration = 0, audioPaused = false, onAudioPlayPause, onAudioSeek, mobile, mobileRecording, mobilePaused, mobileTranscribing, onMobileRecord, onMobileCancelRecord, onMobilePauseRecord, onMobileResumeRecord, onOpenSettings, onStartVoice, voiceReady = false, isActive = true, draftKey, paneIndex = 0, awaitingConfirmation = false, onConfirm, onDecline, mobileSlotIndicator, infoPaneOpen = false, chatTitle: _chatTitle = '', }: Props) {
  const agentName = useMainAgentName()
  const dualActive = dualMode || dualRunning
  const draftStorageKey = draftKey ? `control:draft:${draftKey}` : null
  const [text, setText] = useState(() => {
    if (!draftStorageKey) return ''
    try { return localStorage.getItem(draftStorageKey) || '' } catch { return '' }
  })
  // Beim Wechsel der Chat-ID Entwurf neu laden
  const lastDraftKeyRef = useRef(draftKey)
  useEffect(() => {
    if (lastDraftKeyRef.current === draftKey) return
    lastDraftKeyRef.current = draftKey
    if (!draftStorageKey) { setText(''); return }
    try { setText(localStorage.getItem(draftStorageKey) || '') } catch { setText('') }
  }, [draftKey, draftStorageKey])
  // Bei jeder Text-Änderung Entwurf speichern (oder löschen wenn leer)
  useEffect(() => {
    if (!draftStorageKey) return
    try {
      if (text) localStorage.setItem(draftStorageKey, text)
      else localStorage.removeItem(draftStorageKey)
    } catch {}
  }, [text, draftStorageKey])
  const [files, setFiles] = useState<Attachment[]>([])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('deck:composerLayout', { detail: { paneIndex } }))
    const raf = requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('deck:composerLayout', { detail: { paneIndex } }))
    })
    return () => cancelAnimationFrame(raf)
  }, [text, files.length, paneIndex])
  // Aktuelle Anhaenge an die Pane melden, damit Voice- oder Backend-Sends sie mitnehmen koennen.
  useEffect(() => {
    const ready = files.filter(f => !f.uploading)
    window.dispatchEvent(new CustomEvent('deck:composerAttachments', { detail: { paneIndex, attachments: ready } }))
    if (mobile) {
      // Legacy-Event fuer Bestandscode, der noch deck:mobileAttachments hoert.
      window.dispatchEvent(new CustomEvent('deck:mobileAttachments', { detail: { paneIndex, attachments: ready } }))
    }
  }, [files, mobile, paneIndex])
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if ((d.paneIndex ?? 0) !== paneIndex) return
      setFiles([])
    }
    window.addEventListener('deck:consumeComposerAttachments', handler)
    window.addEventListener('deck:consumeMobileAttachments', handler)
    return () => {
      window.removeEventListener('deck:consumeComposerAttachments', handler)
      window.removeEventListener('deck:consumeMobileAttachments', handler)
    }
  }, [paneIndex])
  // Vorbefüllung aus Quick-Add-Pillen: Text in den Composer schreiben ohne abzusenden,
  // damit Christian vor dem Enter noch editieren kann.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if ((d.paneIndex ?? 0) !== paneIndex) return
      const text = String(d.text || '')
      if (!text) return
      setText(text)
      requestAnimationFrame(() => {
        const el = ref.current
        if (el) {
          el.focus()
          try { el.setSelectionRange(text.length, text.length) } catch {}
        }
      })
    }
    window.addEventListener('deck:composerFill', handler)
    return () => window.removeEventListener('deck:composerFill', handler)
  }, [paneIndex])
  const [dragging, setDragging] = useState(false)
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null)
  const [slash, setSlash] = useState<{ query: string; index: number } | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [showEffort, setShowEffort] = useState(false)
  const effortRootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showEffort) return
    const onDown = (e: MouseEvent) => {
      if (effortRootRef.current && !effortRootRef.current.contains(e.target as Node)) setShowEffort(false)
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowEffort(false) }
    setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc) }
  }, [showEffort])
  // Desktop: Toggles wandern in den Tab-Strip-Header. Mobile: nur das Model-Menü geht in die Hero-Zeile.
  const [headerControlsTarget, setHeaderControlsTarget] = useState<HTMLElement | null>(null)
  const [mobileModelTarget, setMobileModelTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const find = () => {
      setHeaderControlsTarget(mobile ? null : document.getElementById(`chat-pane-controls-${paneIndex}`))
      setMobileModelTarget(mobile ? document.getElementById('mobile-hero-model-controls') : null)
    }
    find()
    // Falls Container noch nicht im DOM ist: retry per microtask + ein paar frames.
    const t1 = setTimeout(find, 0)
    const t2 = setTimeout(find, 100)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [mobile, paneIndex])
  const headerControlsCompact = !mobile && !!headerControlsTarget
  const headerControlIconClass = headerControlsCompact ? 'w-4 h-4' : 'w-[20px] h-[20px]'
  const headerControlLogoSize = headerControlsCompact ? 16 : 20
  const [showPlusMenu, setShowPlusMenu] = useState(false)
  const plusMenuRootRef = useRef<HTMLDivElement>(null)
  const [mobileMenuLine, setMobileMenuLine] = useState(initialMobileMenuLine)
  // Fokus-Overlay-Status (von MobileApp via deck:fokusState gemeldet) — steuert
  // Label und Icon-Farbe im Plus-Menü, analog zu infoPaneOpen bei WhatsApp.
  const [fokusOpen, setFokusOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const [werkbankOpen, setWerkbankOpen] = useState(false)
  const werkbankSignal = useWerkbankNavSignal()
  const [mobileMenuAreaOpen, setMobileMenuAreaOpen] = useState(false)
  useEffect(() => {
    const h = (e: Event) => setFokusOpen(!!(e as CustomEvent).detail?.open)
    window.addEventListener('deck:fokusState', h)
    return () => window.removeEventListener('deck:fokusState', h)
  }, [])
  useEffect(() => {
    const h = (e: Event) => setHealthOpen(!!(e as CustomEvent).detail?.open)
    window.addEventListener('deck:healthState', h)
    return () => window.removeEventListener('deck:healthState', h)
  }, [])
  useEffect(() => {
    const h = (e: Event) => setWerkbankOpen(!!(e as CustomEvent).detail?.open)
    window.addEventListener('deck:werkbankState', h)
    return () => window.removeEventListener('deck:werkbankState', h)
  }, [])
  useEffect(() => {
    const h = (e: Event) => setMobileMenuAreaOpen(!!(e as CustomEvent).detail?.open)
    window.addEventListener('deck:mobileMenuAreaState', h)
    return () => window.removeEventListener('deck:mobileMenuAreaState', h)
  }, [])
  const [showBrainMenu, setShowBrainMenu] = useState(false)
  const brainMenuRootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showBrainMenu) return
    const onDocClick = (e: MouseEvent) => {
      if (brainMenuRootRef.current && !brainMenuRootRef.current.contains(e.target as Node)) setShowBrainMenu(false)
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowBrainMenu(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onEsc) }
  }, [showBrainMenu])
  useEffect(() => {
    if (!showPlusMenu) return
    const onDown = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-plus-menu]')) return
      if ((e.target as Element | null)?.closest?.('[data-plus-trigger]')) return
      if (plusMenuRootRef.current && !plusMenuRootRef.current.contains(e.target as Node)) setShowPlusMenu(false)
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowPlusMenu(false) }
    setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc) }
  }, [showPlusMenu])
  useEffect(() => {
    if (!mobile || !isActive) return
    let cancelled = false
    const cached = readMobileMenuLineCache()
    if (cached?.line) setMobileMenuLine(cached.line)
    else setMobileMenuLine(buildMobileMenuLine(null))

    fetch('/api/fokus/briefing')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (cancelled) return
        const payload = (data?.payload || null) as MobileMenuBriefingPayload | null
        const now = new Date()
        const signature = mobileMenuSignature(payload, now)
        const existing = readMobileMenuLineCache(now)
        const line = existing?.signature === signature
          ? existing.line
          : buildMobileMenuLine(payload, now)
        setMobileMenuLine(line)
        try {
          localStorage.setItem(MOBILE_MENU_LINE_KEY, JSON.stringify({ day: localDayKey(now), signature, line }))
        } catch {}
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [mobile, isActive])
  const [focused, setFocused] = useState(false)
  const mood: KlausMood = 'idle'
  const voice = useVoiceState()
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  // Voice-First-Modus auf Mobile: ein globaler Schalter fuer alle Chat-Panes.
  const [voiceFirstCollapsed, setVoiceFirstCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(MOBILE_VOICE_FIRST_KEY) !== '0' } catch { return true }
  })
  const setMobileVoiceFirstCollapsed = useCallback((next: boolean) => {
    setVoiceFirstCollapsed(next)
    try { localStorage.setItem(MOBILE_VOICE_FIRST_KEY, next ? '1' : '0') } catch {}
    window.dispatchEvent(new CustomEvent(MOBILE_VOICE_FIRST_SYNC_EVENT, { detail: { collapsed: next } }))
  }, [])
  useEffect(() => {
    const onSync = (e: Event) => {
      const next = !!(e as CustomEvent).detail?.collapsed
      setVoiceFirstCollapsed(next)
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== MOBILE_VOICE_FIRST_KEY) return
      setVoiceFirstCollapsed(e.newValue !== '0')
    }
    window.addEventListener(MOBILE_VOICE_FIRST_SYNC_EVENT, onSync)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(MOBILE_VOICE_FIRST_SYNC_EVENT, onSync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  useEffect(() => {
    if (!mobile) return
    const onReturn = () => {
      setShowPlusMenu(false)
    }
    window.addEventListener('deck:returnToChatPane', onReturn)
    return () => window.removeEventListener('deck:returnToChatPane', onReturn)
  }, [mobile])
  useEffect(() => {
    if (!mobileRecording) { setRecordingSeconds(0); return }
    if (mobilePaused) return
    const t = setInterval(() => setRecordingSeconds(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [mobileRecording, mobilePaused])

  // Mobile: Composer-Höhe per ResizeObserver an MobileApp melden — damit das InfoPane-Overlay
  // unten Platz für den Composer freilässt. Nur der aktive Slot meldet, sonst kippen die
  // display:none-Composer den global geteilten Wert auf 0 oder eine fremde Größe.
  const [composerWrapNode, setComposerWrapNode] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!mobile || !isActive || !composerWrapNode || typeof ResizeObserver === 'undefined') return
    const dispatch = () => {
      const h = composerWrapNode.getBoundingClientRect().height
      if (h > 0) window.dispatchEvent(new CustomEvent('deck:composerHeight', { detail: { height: h } }))
    }
    const ro = new ResizeObserver(dispatch)
    ro.observe(composerWrapNode)
    dispatch()
    return () => ro.disconnect()
  }, [mobile, isActive, composerWrapNode])

  // Agent-Mood: deaktiviert. Bleibt statisch bei 'idle' (Default-Auge).
  // Random-Tick + Idle-Decay liefen pro Composer-Instanz dauerhaft im Hintergrund —
  // auf Mobile spürbar in der Gesamt-Performance, und Christian braucht die
  // Animation nicht. lastActivity bleibt unbenutzt, kann später ggf. weg.


  // Insert quote text when triggered
  useEffect(() => {
    if (quoteText) {
      setText(prev => quoteText + prev)
      onQuoteConsumed?.()
      ref.current?.focus()
    }
  }, [quoteText, onQuoteConsumed])


  const addFiles = useCallback((fileList: FileList | File[]) => {
    const newFiles = Array.from(fileList)
    for (const file of newFiles) {
      if (file.size > 30 * 1024 * 1024) {
        window.dispatchEvent(new CustomEvent('deck:toast', { detail: { message: `${file.name} ist zu gross (max. 30 MB)` } }))
        continue
      }
      // Audio files → upload as regular attachment (transcribed server-side)
      if (isAudioFile(file)) {
        const attachment: Attachment = {
          name: file.name,
          url: '',
          type: file.type || 'audio/mpeg',
          size: file.size,
          uploading: true,
          file,
        }
        setFiles(prev => [...prev, attachment])
        uploadFile(file).then(result => {
          setFiles(prev => prev.map(f => f.file === file ? { ...result, preview: f.preview } : f))
        }).catch(() => {
          setFiles(prev => prev.filter(f => f.file !== file))
        })
        continue
      }
      const attachment: Attachment = {
        name: file.name,
        url: '',
        type: file.type,
        size: file.size,
        uploading: true,
        file,
      }
      // Image preview
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = e => {
          setFiles(prev => prev.map(f => f.file === file ? { ...f, preview: e.target?.result as string } : f))
        }
        reader.readAsDataURL(file)
      }
      setFiles(prev => [...prev, attachment])
      // Upload immediately
      uploadFile(file).then(result => {
        setFiles(prev => prev.map(f => f.file === file ? { ...result, preview: f.preview } : f))
      }).catch(() => {
        setFiles(prev => prev.filter(f => f.file !== file))
      })
    }
  }, [])

  const removeFile = useCallback((index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index))
  }, [])

  // Drag & Drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
  }, [addFiles])

  // Externes Add (z. B. Drop auf den Chat-Bereich): Dateien in den Composer übernehmen.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if ((d.paneIndex ?? 0) !== paneIndex) return
      const fl = d.files as FileList | File[] | undefined
      if (!fl || (fl as FileList).length === 0) return
      addFiles(fl)
    }
    window.addEventListener('deck:addFiles', handler)
    return () => window.removeEventListener('deck:addFiles', handler)
  }, [paneIndex, addFiles])

  // Externes Append (z. B. Paste irgendwo in der Chat-Pane): Text in Composer uebernehmen, Fokus rein.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if ((d.paneIndex ?? 0) !== paneIndex) return
      const incoming = typeof d.text === 'string' ? d.text : ''
      if (!incoming) return
      setText(prev => {
        const sep = prev && !prev.endsWith('\n') && !prev.endsWith(' ') ? ' ' : ''
        return prev + sep + incoming
      })
      requestAnimationFrame(() => {
        const ta = ref.current
        if (!ta) return
        ta.focus()
        const end = ta.value.length
        try { ta.setSelectionRange(end, end) } catch {}
      })
    }
    window.addEventListener('deck:appendText', handler)
    return () => window.removeEventListener('deck:appendText', handler)
  }, [paneIndex])

  // Clipboard paste
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    const imageFiles: File[] = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length) {
      e.preventDefault()
      addFiles(imageFiles)
    }
  }, [addFiles])

  const focusComposerForPaste = useCallback(() => {
    setMobileVoiceFirstCollapsed(false)
    window.setTimeout(() => {
      const ta = ref.current
      if (!ta) return
      ta.focus()
      const end = ta.value.length
      try { ta.setSelectionRange(end, end) } catch {}
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, mobile ? 56 : 180) + 'px'
    }, 0)
  }, [mobile, setMobileVoiceFirstCollapsed])

  const submitClipboardTextToCurrentPane = useCallback(async () => {
    const focusComposer = () => {
      focusComposerForPaste()
    }
    try {
      const incoming = (await navigator.clipboard?.readText?.() || '').trim()
      if (!incoming) {
        focusComposer()
        return
      }
      if (disabled || files.some(f => f.uploading)) {
        setText(prev => {
          if (!prev.trim()) return incoming
          const sep = prev.endsWith('\n') || prev.endsWith(' ') ? '' : '\n'
          return `${prev}${sep}${incoming}`
        })
        focusComposer()
        return
      }
      onSend(incoming)
      setText('')
      setFiles([])
      setMobileVoiceFirstCollapsed(true)
      if (ref.current) ref.current.style.height = 'auto'
    } catch {
      focusComposer()
    }
  }, [disabled, files, focusComposerForPaste, onSend, setMobileVoiceFirstCollapsed])


  // Mention detection
  const detectMention = useCallback((value: string, cursorPos: number) => {
    const before = value.slice(0, cursorPos)
    const match = before.match(/@(\w*)$/)
    if (match) {
      setMention({ query: match[1].toLowerCase(), index: 0 })
    } else {
      setMention(null)
    }
  }, [])

  const filteredAgents = mention
    ? AGENTS.filter(a => a.name.toLowerCase().startsWith(mention.query) || a.id.startsWith(mention.query))
    : []

  const selectMention = useCallback((agentId: string) => {
    const ta = ref.current
    if (!ta) return
    const before = text.slice(0, ta.selectionStart)
    const after = text.slice(ta.selectionStart)
    const atPos = before.lastIndexOf('@')
    const newText = before.slice(0, atPos) + after
    setText(newText)
    setMention(null)
    onAgentChange(agentId)
    setTimeout(() => {
      ta.focus()
      const pos = atPos
      ta.setSelectionRange(pos, pos)
    }, 0)
  }, [text, onAgentChange])

  const handleMentionKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!mention || filteredAgents.length === 0) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setMention(prev => prev ? { ...prev, index: Math.min(prev.index + 1, filteredAgents.length - 1) } : null)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setMention(prev => prev ? { ...prev, index: Math.max(prev.index - 1, 0) } : null)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      selectMention(filteredAgents[mention.index].id)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setMention(null)
      return true
    }
    return false
  }, [mention, filteredAgents, selectMention])

  // Slash command detection — wird anhand der Engine gefiltert.
  const isCodex = engine === 'codex'
  const detectSlash = useCallback((value: string) => {
    const match = value.match(/^\/(\w*)$/)
    if (match) {
      setSlash({ query: match[1].toLowerCase(), index: 0 })
    } else {
      setSlash(null)
    }
  }, [])

  const filteredCommands = slash
    ? SLASH_COMMANDS.filter(c => {
        if (c.hidden) return false
        const matchesQuery = c.cmd.slice(1).startsWith(slash.query)
        return matchesQuery && matchEngine(c, isCodex)
      })
    : []

  const selectSlashCommand = useCallback((cmd: SlashCommand) => {
    if (cmd.hint) {
      setText(cmd.cmd + ' ')
      setSlash(null)
      ref.current?.focus()
    } else {
      onCommand?.(cmd.cmd, '')
      setText('')
      setSlash(null)
    }
  }, [onCommand])

  const handleSlashKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!slash || filteredCommands.length === 0) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSlash(prev => prev ? { ...prev, index: Math.min(prev.index + 1, filteredCommands.length - 1) } : null)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSlash(prev => prev ? { ...prev, index: Math.max(prev.index - 1, 0) } : null)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      selectSlashCommand(filteredCommands[slash.index])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setSlash(null)
      return true
    }
    return false
  }, [slash, filteredCommands, selectSlashCommand])

  const hasContent = text.trim() || files.some(f => !f.uploading)
  const isUploading = files.some(f => f.uploading)
  const showDesktopComposerTools = focused || !!hasContent || busy || !!isPlaying || awaitingConfirmation || dragging || !!slash || !!mention

  // WhatsApp-Hijack: Wenn MobileApp ein deck:waSendTarget mit chat_id dispatched
  // (= WA-Thread offen), routet Send immer an /api/whatsapp/draft.
  // Senden passiert erst über den separaten Draft-Confirm.
  const waTargetRef = useRef<{ chat_id: string | null; account: string | null; uid: string | null; draft: boolean; previousDraft: string }>({ chat_id: null, account: null, uid: null, draft: false, previousDraft: '' })
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      waTargetRef.current = {
        chat_id: typeof d.chat_id === 'string' && d.chat_id ? d.chat_id : null,
        account: typeof d.account === 'string' && d.account ? d.account : null,
        uid: typeof d.uid === 'string' && d.uid ? d.uid : null,
        draft: !!d.draft,
        previousDraft: typeof d.previousDraft === 'string' ? d.previousDraft : '',
      }
    }
    window.addEventListener('deck:waSendTarget', handler)
    return () => window.removeEventListener('deck:waSendTarget', handler)
  }, [])

  // WA-Draft-Pending: Composer übernimmt ✓/✕-Buttons während ein Draft auf Bestätigung wartet.
  const [waDraftPending, setWaDraftPending] = useState(false)
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      setWaDraftPending(!!d.active)
    }
    window.addEventListener('deck:waDraftPending', handler)
    return () => window.removeEventListener('deck:waDraftPending', handler)
  }, [])

  // WA-Thread offen (zeigt Draft-Sprechbubble im linken Slot) + Draft-Mode-Status (Farbe).
  const [waThreadOpen, setWaThreadOpen] = useState(false)
  // Brain-Stufe fuers Icon: 'off' = grau, 'light' = weiss (nur das Neue), 'full' = terracotta (ganzer Faden).
  const [waBrainStage, setWaBrainStage] = useState<'off' | 'light' | 'full'>('off')
  const [waWaitingCount, setWaWaitingCount] = useState(0)
  const [waWaitingHasUnread, setWaWaitingHasUnread] = useState(false)
  const [waWaitingKeys, setWaWaitingKeys] = useState<string[]>([])
  const markCurrentInboxSeen = useCallback(() => {
    markInboxWaitingSeen(waWaitingKeys)
    setWaWaitingHasUnread(false)
  }, [waWaitingKeys])
  useEffect(() => {
    const onTarget = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      setWaThreadOpen((typeof d.chat_id === 'string' && !!d.chat_id) || (typeof d.account === 'string' && !!d.account && typeof d.uid === 'string' && !!d.uid))
    }
    const onMode = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      const stage = d.stage === 'full' || d.stage === 'light' ? d.stage : (d.active ? 'light' : 'off')
      setWaBrainStage(stage)
    }
    window.addEventListener('deck:waSendTarget', onTarget)
    window.addEventListener('deck:waDraftMode', onMode)
    return () => {
      window.removeEventListener('deck:waSendTarget', onTarget)
      window.removeEventListener('deck:waDraftMode', onMode)
    }
  }, [])

  useEffect(() => {
    if (!mobile) {
      setWaWaitingCount(0)
      setWaWaitingHasUnread(false)
      setWaWaitingKeys([])
      return
    }

    let cancelled = false
    const loadWaWaitingCount = async () => {
      try {
        const r = await fetch('/api/whatsapp/chats?limit=200&include_archived=true')
        if (!r.ok) return
        const d = await r.json()
        const chats: WaStatusChat[] = Array.isArray(d?.chats) ? d.chats : []
        if (!cancelled) {
          const waiting = chats.filter(c => c.triage === 'waiting_on_me' && !c.is_archived)
          let mailCount = 0
          let mailKeys: Array<string | null> = []
          try {
            const mr = await fetch('/api/inbox/mail-attention?limit=80')
            if (mr.ok) {
              const md = await mr.json()
              // Nur echte Wartende zaehlen: beantwortete Mails (replied) stehen
              // bereits in "E-Mails", nicht in "Wartet", und duerfen den Badge nicht aufblaehen.
              const mailWaiting = Array.isArray(md?.items) ? md.items.filter((it: { replied?: boolean }) => !it.replied) : []
              mailCount = mailWaiting.length
              mailKeys = mailWaiting.map((it: { account?: string; uid?: string; ts?: number | null }) => inboxMailWaitingKey(it))
            }
          } catch {}
          const waitingKeys = [
            ...waiting.map(inboxWaWaitingKey),
            ...mailKeys,
          ].filter((key): key is string => !!key)
          setWaWaitingCount(waiting.length + mailCount)
          setWaWaitingKeys(waitingKeys)
          setWaWaitingHasUnread(hasUnseenInboxWaiting(waitingKeys))
        }
      } catch {}
    }

    loadWaWaitingCount()
    const interval = window.setInterval(() => {
      if (!document.hidden) loadWaWaitingCount()
    }, 30000)
    const refresh = () => { loadWaWaitingCount() }
    window.addEventListener('deck:waMessageSent', refresh)
    window.addEventListener('wa:sent', refresh)
    window.addEventListener('deck:inboxChanged', refresh)
    window.addEventListener(INBOX_SEEN_CHANGED_EVENT, refresh)
    window.addEventListener('deck:toggleInfoPane', refresh)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('deck:waMessageSent', refresh)
      window.removeEventListener('wa:sent', refresh)
      window.removeEventListener('deck:inboxChanged', refresh)
      window.removeEventListener(INBOX_SEEN_CHANGED_EVENT, refresh)
      window.removeEventListener('deck:toggleInfoPane', refresh)
    }
  }, [mobile])

  useEffect(() => {
    if (mobile && infoPaneOpen) markCurrentInboxSeen()
  }, [mobile, infoPaneOpen, markCurrentInboxSeen])

  const send = () => {
    if (!hasContent || disabled || isUploading) return
    const trimmed = text.trim()

    // Check for slash commands with args (e.g. "/model gpt-5.5")
    const slashMatch = trimmed.match(/^\/(\w+)\s*(.*)$/)
    if (slashMatch) {
      const cmdName = `/${slashMatch[1]}`
      const cmdDef = SLASH_COMMANDS.find(c => c.cmd === cmdName)
      if (cmdDef) {
        if (matchEngine(cmdDef, isCodex)) {
          onCommand?.(cmdName, slashMatch[2].trim())
          setText('')
          setSlash(null)
          if (ref.current) ref.current.style.height = 'auto'
          return
        }
      }
    }

    const readyFiles = files.filter(f => !f.uploading)

    // WA-Hijack: ein offener WhatsApp-Thread schluckt den Send und baut nur einen Draft.
    const waTarget = waTargetRef.current
    if (waTarget.chat_id) {
      const chatId = waTarget.chat_id
      window.dispatchEvent(new CustomEvent('deck:waDraftStart', { detail: { chat_id: chatId } }))
      fetch('/api/whatsapp/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, hint: trimmed, previousDraft: waTarget.previousDraft }),
      }).then(r => r.ok ? r.json() : null).then((d: any) => {
        const draftText = (d?.draft || d?.text || '').trim()
        const notice = typeof d?.notice === 'string' ? d.notice : ''
        if (draftText) {
          window.dispatchEvent(new CustomEvent('deck:waDraftResult', { detail: { chat_id: chatId, text: draftText, notice } }))
        } else {
          window.dispatchEvent(new CustomEvent('deck:waDraftResult', { detail: { chat_id: chatId, text: '', error: true, hint: trimmed, notice } }))
        }
      }).catch(() => {
        window.dispatchEvent(new CustomEvent('deck:waDraftResult', { detail: { chat_id: chatId, text: '', error: true, hint: trimmed } }))
      })
      setText('')
      setFiles([])
      if (ref.current) ref.current.style.height = 'auto'
      return
    }
    if (waTarget.account && waTarget.uid) {
      const account = waTarget.account
      const uid = waTarget.uid
      const mailKey = `${account}:${uid}`
      window.dispatchEvent(new CustomEvent('deck:waDraftStart', { detail: { mail_key: mailKey, account, uid } }))
      fetch('/api/mail/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, uid, hint: trimmed, previousDraft: waTarget.previousDraft }),
      }).then(r => r.ok ? r.json() : null).then((d: any) => {
        const draftText = (d?.draft || d?.text || '').trim()
        const notice = typeof d?.notice === 'string' ? d.notice : ''
        if (draftText) {
          window.dispatchEvent(new CustomEvent('deck:waDraftResult', { detail: { mail_key: mailKey, account, uid, text: draftText, notice } }))
        } else {
          window.dispatchEvent(new CustomEvent('deck:waDraftResult', { detail: { mail_key: mailKey, account, uid, text: '', error: true, hint: trimmed, notice } }))
        }
      }).catch(() => {
        window.dispatchEvent(new CustomEvent('deck:waDraftResult', { detail: { mail_key: mailKey, account, uid, text: '', error: true, hint: trimmed } }))
      })
      setText('')
      setFiles([])
      if (ref.current) ref.current.style.height = 'auto'
      return
    }

    onSend(trimmed, undefined, readyFiles.length ? readyFiles : undefined)
    setText('')
    setFiles([])
    if (ref.current) ref.current.style.height = 'auto'
  }

  // Mobile composer — full width, no rounded corners, flush to bottom
  if (mobile) {
    // Voice-First-View ist auf Mobile immer der Composer. Tastatur-Toggle wechselt
    // nur die Mitte (Agent-Avatar ↔ Textarea) und den rechten Button (Tastatur ↔ Send),
    // die Höhe und Außenstruktur bleiben identisch.
    const voiceFirstActive = true
    if (voiceFirstActive) {
      const isRec = !!mobileRecording
      const s = recordingSeconds
      const recTimer = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      const showConfirmHaken = !busy && awaitingConfirmation && !isRec && !!onConfirm
      const showConfirmAction = showConfirmHaken && !infoPaneOpen
      const showPlusButton = !waDraftPending && !isRec && !hasContent && !showConfirmAction
      const mobileRightActionWidth = showPlusButton && !voiceFirstCollapsed ? '92px' : '52px'
      const mobilePlusHitWidth = voiceFirstCollapsed ? 176 : 120
      const wrapClass = `composer-mobile-wrap relative rounded-b-none border-t border-x-0 border-b-0 px-5 transition-all duration-300 ${
        isRec ? `recording-active${mobilePaused ? ' recording-paused' : ''}` : (voiceClass(voice) || 'border-[var(--border-f)]')
      }`
      return (
        <>
          {isRec && (
            <div className={`recording-screen-frame${mobilePaused ? ' paused' : ''}`} aria-hidden />
          )}
          <div
            ref={setComposerWrapNode}
            className={wrapClass}
            style={{
              background: 'var(--bg)',
              borderTopLeftRadius: 0,
              borderTopRightRadius: 0,
              paddingTop: 4,
              paddingBottom: 'max(0px, calc(env(safe-area-inset-bottom, 0px) - 22px))',
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,audio/*,.m4a,.mp3,.ogg,.wav,.flac,.aac,.webm,.txt,.md,.json,.csv,.pdf,.xlsx,.xlsm,.xls,.docx,.doc,.py,.js,.ts,.html,.css"
              className="hidden"
              onChange={e => { if (e.target.files?.length) { addFiles(e.target.files); e.target.value = '' } }}
            />
            {/* File-Previews: kompakte Pillen über der Tools-Row, mit Thumbnail und X. */}
            {files.length > 0 && !isRec && (
              <div className="flex flex-wrap gap-1.5 pb-2">
                {files.map((f, i) => (
                  <div key={i} className="relative flex items-center gap-2 bg-[var(--bg-2)] border border-[var(--border-f)] rounded-xl pl-1.5 pr-2.5 py-1.5 max-w-[200px]">
                    {f.preview ? (
                      <img src={f.preview} alt="" className="w-9 h-9 rounded-lg object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-9 h-9 rounded-lg bg-[var(--bg-3)] flex items-center justify-center flex-shrink-0">
                        {f.type.startsWith('image/')
                          ? <Image className="w-4 h-4 text-[var(--t3)]" />
                          : <FileText className="w-4 h-4 text-[var(--t3)]" />}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="text-[14px] text-[var(--t1)] truncate leading-tight">{f.name}</div>
                      <div className="text-[12px] text-[var(--t3)] leading-tight">
                        {f.uploading ? 'Lädt…' : formatSize(f.size)}
                      </div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); removeFile(i) }}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[var(--bg-3)] border border-[var(--border-f)] flex items-center justify-center text-[var(--t2)] active:text-[var(--t1)] cursor-pointer"
                      aria-label="Anhang entfernen"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Tools-Row: Slot-Punkte bleiben auch während Recording sichtbar. */}
            <div className="relative flex items-center" style={{ minHeight: 32 }}>
              <div className="w-full">{mobileSlotIndicator}</div>
            </div>

            {!isRec && isPlaying && onStopAudio && onAudioPlayPause && onAudioSeek && (
              <div className="flex items-center gap-3 pt-2 pb-1" onClick={e => e.stopPropagation()}>
                <button
                  onClick={e => { e.stopPropagation(); onAudioPlayPause() }}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)] cursor-pointer flex-shrink-0"
                  title={audioPaused ? 'Weiter' : 'Pause'}
                  aria-label={audioPaused ? 'Weiter' : 'Pause'}
                >
                  {audioPaused
                    ? <Play className="w-4 h-4" fill="currentColor" style={{ marginLeft: 1 }} />
                    : <Pause className="w-4 h-4" fill="currentColor" />
                  }
                </button>
                <span className="text-[14px] text-[var(--t3)] tabular-nums flex-shrink-0">
                  {formatTime(audioTime)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={audioDuration || 0}
                  step={0.1}
                  value={Math.min(audioTime, audioDuration || audioTime || 0)}
                  onChange={e => onAudioSeek(Number(e.target.value))}
                  onPointerDown={e => e.stopPropagation()}
                  className="audio-scrubber flex-1"
                  style={{ ['--pct' as string]: `${audioDuration > 0 ? Math.min(100, (audioTime / audioDuration) * 100) : 0}%` }}
                  aria-label="Audio-Position"
                />
                <span className="text-[14px] text-[var(--t3)] tabular-nums flex-shrink-0">
                  {formatTime(audioDuration)}
                </span>
                <button
                  onClick={e => { e.stopPropagation(); onStopAudio() }}
                  className="flex items-center justify-center text-[var(--t3)] active:text-[var(--t1)] cursor-pointer p-0.5 flex-shrink-0"
                  title="Audio stoppen"
                  aria-label="Audio stoppen"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            )}

            {/* Action-Row — Agent mittig (kompakter), Side-Slots für je 2 Icons.
                Composer-Höhe bleibt in jedem Zustand identisch: Recording-Timer
                wandert in die Pillen-Mitte oben, das Wort "Aufnahme" entfällt. */}
            <div
              className="grid items-center gap-3 pt-0 pb-0"
              style={{
                marginTop: 6,
                gridTemplateColumns: showConfirmAction
                  ? '52px 1fr 52px'
                  : (!isRec && !voiceFirstCollapsed)
                    ? ((busy || waDraftPending || waThreadOpen) ? `52px 1fr ${mobileRightActionWidth}` : `0px 1fr ${mobileRightActionWidth}`)
                    : '52px 1fr 52px',
              }}
            >
              {/* Linker Slot: InfoPane (außen) + Chats (innen) — Stop ersetzt Chats wenn busy.
                  Äußerster Button bekommt -12px marginLeft, damit Icon-Kante mit Plus oben fluchtet. */}
              <div className="flex items-center justify-start gap-2 overflow-hidden">
                {waDraftPending ? (
                  <button
                    onClick={e => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('deck:waDraftDiscard')) }}
                    className="flex h-[54px] w-[54px] items-center justify-center rounded-full cursor-pointer"
                    style={{ marginLeft: 0, color: '#d97757' }}
                    title="Draft verwerfen"
                    aria-label="Draft verwerfen"
                  >
                    <X className="w-7 h-7" strokeWidth={2.25} />
                  </button>
                ) : isRec ? (
                  <button
                    onClick={e => { e.stopPropagation(); onMobileCancelRecord?.() }}
                    className="flex h-[54px] w-[54px] items-center justify-center rounded-full text-[var(--t2)] active:text-[var(--t1)] cursor-pointer"
                    style={{ marginLeft: 0 }}
                    title="Aufnahme verwerfen"
                    aria-label="Aufnahme verwerfen"
                  >
                    <Trash2 className="w-7 h-7" />
                  </button>
                ) : showConfirmAction && onDecline ? (
                  <button
                    onClick={e => { e.stopPropagation(); onDecline() }}
                    className="flex h-[54px] w-[54px] items-center justify-center rounded-full text-[var(--t2)] active:text-[var(--t1)] cursor-pointer"
                    style={{ marginLeft: 0 }}
                    title="Ablehnen"
                    aria-label="Ablehnen"
                  >
                    <X className="w-7 h-7" />
                  </button>
                ) : busy && !waThreadOpen ? (
                  <button
                    onPointerDown={e => { e.stopPropagation(); onCommand?.('/stop', '') }}
                    className="flex h-[54px] w-[54px] items-center justify-center rounded-full text-[var(--t2)] active:text-[var(--t1)] cursor-pointer"
                    style={{ marginLeft: 0 }}
                    title="Agent stoppen"
                    aria-label="Agent stoppen"
                  >
                    <Square className="w-6 h-6" fill="currentColor" />
                  </button>
                ) : waThreadOpen ? (
                  <button
                    onClick={e => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('deck:waDraftToggle')) }}
                    className="flex h-[54px] w-[54px] items-center justify-center rounded-full cursor-pointer"
                    style={{ marginLeft: 0, color: waBrainStage === 'full' ? '#d97757' : waBrainStage === 'light' ? 'var(--t1)' : 'var(--t2)' }}
                    title={waBrainStage === 'off' ? 'Lagebild laden' : waBrainStage === 'light' ? 'Ganzer Faden' : 'Lagebild ausblenden'}
                    aria-label={waBrainStage === 'off' ? 'Lagebild laden' : waBrainStage === 'light' ? 'Ganzer Faden laden' : 'Lagebild ausblenden'}
                  >
                    <Brain className="w-7 h-7" strokeWidth={1.75} fill="none" />
                  </button>
                ) : voice.active ? (
                  // Auflegen — beendet die Voice-Session. Der Orb selbst pausiert nur.
                  <button
                    onClick={e => { e.stopPropagation(); onStartVoice?.() }}
                    className="flex h-[54px] w-[54px] items-center justify-center rounded-full text-[var(--t2)] active:text-[#d97757] cursor-pointer"
                    style={{ marginLeft: 0 }}
                    title="Voice beenden"
                    aria-label="Voice beenden"
                  >
                    <PhoneOff className="w-6 h-6" strokeWidth={2} />
                  </button>
                ) : (
                  // Tastatur-Toggle wandert komplett ins +-Menü, kein Slot mehr im Composer.
                  <div className="h-[54px] w-[54px]" />
                )}
              </div>

              {/* Mittlerer Slot — Agent zentriert, oder Textarea wenn Tastatur offen.
                  Confirm-Haken sitzt rechts (statt Plus), nicht zentral, damit Agent als Aufnahme-Button erreichbar bleibt. */}
              <div className="flex items-center justify-center h-[58px] relative">
                {voice.active ? (
                  <button
                    onClick={e => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('deck:voicePause')) }}
                    className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex h-[52px] w-[52px] items-center justify-center rounded-full cursor-pointer active:scale-95 transition-transform"
                    title={voice.phase === 'connecting' ? `${agentName} verbindet …` : voice.isPaused ? 'Weiter' : 'Pause'}
                    aria-label={voice.isPaused ? 'Voice fortsetzen' : 'Voice pausieren'}
                  >
                    <KlausVoiceOrb state={voice} size={52} />
                  </button>
                ) : !isRec && !voiceFirstCollapsed ? (
                  <textarea
                    ref={ref}
                    value={text}
                    onChange={e => {
                      setText(e.target.value)
                      if (ref.current) {
                        ref.current.style.height = 'auto'
                        ref.current.style.height = Math.min(ref.current.scrollHeight, 56) + 'px'
                      }
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        send()
                      }
                    }}
                    placeholder="Nachricht…"
                    rows={1}
                    autoFocus
                    className="absolute left-0 right-0 top-1/2 -translate-y-1/2 resize-none bg-transparent border-0 outline-none text-[20px] text-[var(--t1)] placeholder:text-[var(--t3)] leading-[24px] py-1"
                    style={{ maxHeight: 56 }}
                  />
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); onMobileRecord?.() }}
                    disabled={disabled || mobileTranscribing}
                    className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex h-[50px] items-center justify-center rounded-full transition-all duration-200 disabled:opacity-50 disabled:cursor-default cursor-pointer active:scale-95"
                    style={{
                      width: isRec ? 104 : 50,
                      background: isRec ? 'rgba(217,119,87,0.12)' : 'transparent',
                      border: isRec ? '1px solid rgba(217,119,87,0.38)' : 'none',
                    }}
                    title={isRec ? 'Aufnahme senden' : (busy ? 'Sprache aufnehmen — landet in Queue' : 'Sprache aufnehmen')}
                    aria-label={isRec ? 'Aufnahme senden' : 'Sprache aufnehmen'}
                  >
                    {mobileTranscribing ? (
                      <span className="w-9 h-9 border-[2.5px] border-[var(--t1)] border-t-transparent rounded-full animate-spin" />
                    ) : isRec ? (
                      <span
                        className={`font-mono tabular-nums text-[22px] font-semibold leading-none ${mobilePaused ? 'text-[#d97757]/70' : 'status-shimmer-orange'}`}
                        style={{ fontFamily: 'var(--font-heading)' }}
                      >
                        {recTimer}
                      </span>
                    ) : (
                      <img
                        src={(() => {
                              const moodSvg: Partial<Record<KlausMood, string>> = {
                                idle: '/agent.svg',
                                sleepy: '/agent-sleepy.svg',
                                'peek-right': '/agent-look-right.svg',
                                'peek-left': '/agent-look-left.svg',
                                'peek-up': '/agent-look-up.svg',
                                'peek-down': '/agent-look-down.svg',
                                wink: '/agent-wink.svg',
                                nod: '/agent-nod.svg',
                                shake: '/agent-shake.svg',
                                angry: '/agent-angry.svg',
                                surprised: '/agent-surprised.svg',
                                squint: '/agent-squint.svg',
                              }
                              return moodSvg[mood] || '/agent.svg'
                            })()}
                        alt=""
                        className="w-[52px] h-[52px] transition-opacity duration-150"
                        draggable={false}
                      />
                    )}
                  </button>
                )}
              </div>

              {/* Rechter Slot: Pause (rec) / Send-Pfeil (Text) / Plus-Menü (Default).
                  Engine + Reasoning + Deep + Dual leben oben in der Hero-Zeile via Portal. */}
              <div className="flex items-center justify-end gap-2">
                {waDraftPending ? (
                  <button
                    onClick={e => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('deck:waDraftConfirm')) }}
                    className="flex h-[54px] w-[54px] items-center justify-center rounded-full cursor-pointer"
                    style={{ marginRight: 0, background: '#d97757', color: '#fff' }}
                    title="Draft senden"
                    aria-label="Draft senden"
                  >
                    <Check className="w-7 h-7" strokeWidth={2.75} />
                  </button>
                ) : isRec ? (
                  <button
                    onClick={e => { e.stopPropagation(); if (mobilePaused) onMobileResumeRecord?.(); else onMobilePauseRecord?.() }}
                    className="flex h-[54px] w-[54px] items-center justify-center rounded-full text-[var(--t2)] active:text-[var(--t1)] cursor-pointer"
                    style={{ marginRight: 0 }}
                    title={mobilePaused ? 'Weiter aufnehmen' : 'Pause'}
                    aria-label={mobilePaused ? 'Weiter aufnehmen' : 'Pause'}
                  >
                    {mobilePaused
                      ? <Play className="w-7 h-7" fill="currentColor" style={{ marginLeft: 1 }} />
                      : <Pause className="w-7 h-7" fill="currentColor" />
                    }
                  </button>
                ) : hasContent ? (
                  <button
                    onPointerDown={e => { e.stopPropagation(); send() }}
                    disabled={disabled || isUploading}
                    className="flex h-[54px] w-[54px] items-center justify-center rounded-full text-[var(--t1)] active:text-white transition-all disabled:opacity-30 disabled:cursor-default cursor-pointer"
                    style={{ marginRight: 0 }}
                    title="Senden"
                    aria-label="Senden"
                  >
                    <ArrowUp className="w-7 h-7" strokeWidth={2.25} />
                  </button>
                ) : showConfirmAction ? (
                  <button
                    onClick={e => { e.stopPropagation(); onConfirm?.() }}
                    disabled={disabled}
                    className="confirm-pulse flex h-[54px] w-[54px] items-center justify-center rounded-full cursor-pointer border border-[var(--t1)] text-[var(--t1)]"
                    style={{ marginRight: 0 }}
                    title="Bestätigen"
                    aria-label="Bestätigen"
                  >
                    <Check className="w-7 h-7" strokeWidth={2.5} />
                  </button>
                ) : (
                  <div ref={plusMenuRootRef} className="relative" style={{ transform: 'translateX(-1px)' }}>
                    <div className="pointer-events-none flex h-[54px] w-[54px] items-center justify-center" aria-hidden />
                    {isActive && createPortal((
                      <button
                        data-plus-trigger
                        onClick={e => {
                          e.stopPropagation()
                          if (mobileMenuAreaOpen || infoPaneOpen || fokusOpen || healthOpen || werkbankOpen) {
                            setShowPlusMenu(false)
                            window.dispatchEvent(new CustomEvent('deck:returnToChatPane'))
                            return
                          }
                          setShowPlusMenu(v => !v)
                        }}
                        className="fixed z-40 cursor-pointer"
	                        style={{
	                          right: 0,
	                          bottom: 0,
	                          width: mobilePlusHitWidth,
	                          height: 64,
	                        }}
                        title="Mehr"
                        aria-label="Mehr-Menü öffnen"
                      />
                    ), document.body)}
                    {isActive && showPlusMenu && createPortal((
                      <div
                        className="fixed left-0 right-0 top-0 z-50 flex items-end bg-[var(--bg)] p-3 shadow-none"
                        style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 70px)' }}
                        onClick={() => setShowPlusMenu(false)}
                      >
                        <div
                          data-plus-menu
                          className="flex w-full flex-col"
                          style={{
                            maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 86px)',
                            overflowY: 'auto',
                            WebkitOverflowScrolling: 'touch',
                            overscrollBehavior: 'contain',
                          }}
                          onClick={e => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-center gap-3 pt-1 pb-3">
                          <MobileThemeToggle />
                          <button
                            onClick={e => { e.stopPropagation(); setShowPlusMenu(false); void triggerSafeRestart() }}
                            className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--mobile-chrome-border)] text-[var(--t2)] active:bg-[var(--bg-2)] cursor-pointer"
                            title="Server neu starten"
                            aria-label="Server neu starten"
                          >
                            <RotateCw className="w-[18px] h-[18px]" strokeWidth={1.9} />
                          </button>
                        </div>
                        <div className="mobile-menu-daily-line">
                          {mobileMenuLine}
                        </div>
                        <div className="flex-shrink-0">
                        {onStartVoice && voiceReady && (
                          <button
                            onClick={e => { e.stopPropagation(); setShowPlusMenu(false); onStartVoice?.() }}
                            className={`mb-2 flex h-[76px] w-full items-center gap-[15px] rounded-lg px-[17px] text-left cursor-pointer transition-colors ${voice.active ? 'border border-[#d97757] bg-[color-mix(in_srgb,#d97757_12%,transparent)]' : 'border border-[var(--mobile-chrome-border)] active:bg-[var(--bg-2)]'}`}
                          >
                            {voice.active
                              ? <VoiceBars state={voice} />
                              : <Mic className="w-[29px] h-[29px] flex-shrink-0 text-[#d97757]" strokeWidth={1.75} />}
                            <span className="text-[20px] leading-none text-[var(--t1)]">{voice.active ? 'Voice beenden' : `Mit ${agentName} sprechen`}</span>
                          </button>
                        )}
                        <div className="grid grid-cols-2 gap-2 pb-1">
                          <button
                            onClick={e => { e.stopPropagation(); setShowPlusMenu(false); window.dispatchEvent(new CustomEvent('deck:openSearch')) }}
                            className="flex h-[76px] items-center gap-[15px] rounded-lg border border-[var(--mobile-chrome-border)] px-[17px] text-left cursor-pointer transition-colors active:bg-[var(--bg-2)]"
                          >
                            <Search className="w-[29px] h-[29px] flex-shrink-0 text-[var(--t2)]" strokeWidth={1.75} />
                            <span className="text-[20px] leading-none text-[var(--t1)]">Suche</span>
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); setShowPlusMenu(false); void submitClipboardTextToCurrentPane() }}
                            className="flex h-[76px] items-center gap-[15px] rounded-lg border border-[var(--mobile-chrome-border)] px-[17px] text-left cursor-pointer transition-colors active:bg-[var(--bg-2)]"
                          >
                            <ClipboardPaste className="w-[29px] h-[29px] flex-shrink-0 text-[var(--t2)]" strokeWidth={1.75} />
                            <span className="text-[20px] leading-none text-[var(--t1)]">Einfügen</span>
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); markCurrentInboxSeen(); setShowPlusMenu(false); window.dispatchEvent(new CustomEvent('deck:toggleInfoPane')) }}
                            className="flex h-[76px] items-center gap-[15px] rounded-lg border border-[var(--mobile-chrome-border)] px-[17px] text-left cursor-pointer transition-colors active:bg-[var(--bg-2)]"
                          >
                            <Inbox className={`w-[29px] h-[29px] flex-shrink-0 ${waWaitingHasUnread ? 'text-[#d97757]' : 'text-[var(--t2)]'}`} strokeWidth={1.75} fill="none" />
                            <span className="text-[20px] leading-none text-[var(--t1)]">Inbox</span>
                            {waWaitingCount > 0 && (
                              <span
                                className="ml-auto flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-[16px] font-semibold leading-none tabular-nums"
                                style={{
                                  background: waWaitingHasUnread ? '#d97757' : 'rgba(236,233,228,0.18)',
                                  color: waWaitingHasUnread ? '#fff' : 'var(--t2)',
                                }}
                              >
                                {waWaitingCount > 99 ? '99+' : waWaitingCount}
                              </span>
                            )}
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); setShowPlusMenu(false); window.dispatchEvent(new CustomEvent('deck:toggleFokus')) }}
                            className="flex h-[76px] items-center gap-[15px] rounded-lg border border-[var(--mobile-chrome-border)] px-[17px] text-left cursor-pointer transition-colors active:bg-[var(--bg-2)]"
                          >
                            <Target className={`w-[29px] h-[29px] flex-shrink-0 ${fokusOpen ? 'text-[#d97757]' : 'text-[var(--t2)]'}`} strokeWidth={1.75} />
                            <span className="text-[20px] leading-none text-[var(--t1)]">Fokus</span>
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); setShowPlusMenu(false); window.dispatchEvent(new CustomEvent('deck:toggleHealth')) }}
                            className="flex h-[76px] items-center gap-[15px] rounded-lg border border-[var(--mobile-chrome-border)] px-[17px] text-left cursor-pointer transition-colors active:bg-[var(--bg-2)]"
                          >
                            <HeartPulse className={`w-[29px] h-[29px] flex-shrink-0 ${healthOpen ? 'text-[#d97757]' : 'text-[var(--t2)]'}`} strokeWidth={1.75} />
                            <span className="text-[20px] leading-none text-[var(--t1)]">Health</span>
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); setShowPlusMenu(false); window.dispatchEvent(new CustomEvent('deck:toggleWerkbank')) }}
                            className={`flex h-[76px] items-center gap-[15px] rounded-lg border border-[var(--mobile-chrome-border)] px-[17px] text-left cursor-pointer transition-colors active:bg-[var(--bg-2)] ${werkbankSignal.active > 0 ? 'wb-mobile-active' : ''}`}
                          >
                            <Hammer className={`w-[29px] h-[29px] flex-shrink-0 ${werkbankOpen ? 'text-[color-mix(in_srgb,var(--warm)_72%,var(--t2))]' : 'text-[var(--t2)]'}`} strokeWidth={1.75} />
                            <span className="text-[20px] leading-none text-[var(--t1)]">Werkbank</span>
                            {(werkbankSignal.active > 0 || werkbankSignal.waiting > 0) && (
                              <span className="wb-mobile-count ml-auto text-[16px] font-semibold tabular-nums text-[var(--warm)]" aria-label={werkbankSignal.active > 0 ? `${werkbankSignal.active} laufende Aufträge` : `${werkbankSignal.waiting} wartende Aufträge`}>{werkbankSignal.active || werkbankSignal.waiting}</span>
                            )}
                          </button>
                          <label
                            className="flex h-[76px] items-center gap-[15px] rounded-lg border border-[var(--mobile-chrome-border)] px-[17px] text-left cursor-pointer transition-colors active:bg-[var(--bg-2)]"
                          >
                            <Paperclip className="w-[29px] h-[29px] flex-shrink-0 text-[var(--t2)]" strokeWidth={1.75} />
                            <span className="text-[20px] leading-none text-[var(--t1)]">Anhang</span>
                            <input
                              type="file"
                              multiple
                              accept="image/*,audio/*,.m4a,.mp3,.ogg,.wav,.flac,.aac,.webm,.txt,.md,.json,.csv,.pdf,.xlsx,.xlsm,.xls,.docx,.doc,.py,.js,.ts,.html,.css"
                              className="hidden"
                              onChange={e => { if (e.target.files?.length) { addFiles(e.target.files); e.target.value = '' } setShowPlusMenu(false) }}
                            />
                          </label>
                          <button
                            onClick={e => { e.stopPropagation(); setShowPlusMenu(false); window.location.href = '/remote' }}
                            className="flex h-[72px] items-center gap-3 rounded-lg border border-[var(--mobile-chrome-border)] px-4 text-left cursor-pointer transition-colors active:bg-[var(--bg-2)]"
                          >
                            <MonitorSmartphone className="w-6 h-6 flex-shrink-0 text-[var(--t2)]" strokeWidth={1.75} />
                            <span className="text-[18px] leading-none text-[var(--t1)]">Remote</span>
                          </button>
                          <button
                            onClick={e => {
                              e.stopPropagation()
                              setShowPlusMenu(false)
                              if (voiceFirstCollapsed) {
                                setMobileVoiceFirstCollapsed(false)
                                setTimeout(() => ref.current?.focus(), 0)
                              } else {
                                setMobileVoiceFirstCollapsed(true)
                                ref.current?.blur()
                              }
                            }}
                            className="flex h-[72px] items-center gap-3 rounded-lg border border-[var(--mobile-chrome-border)] px-4 text-left cursor-pointer transition-colors active:bg-[var(--bg-2)]"
                          >
                            <Keyboard className={`w-6 h-6 flex-shrink-0 ${!voiceFirstCollapsed ? 'text-[#d97757]' : 'text-[var(--t2)]'}`} />
                            <span className="text-[18px] leading-none text-[var(--t1)]">Tastatur</span>
                          </button>
                        </div>
                        </div>
                        </div>
                      </div>
                    ), document.body)}
                  </div>
                )}
              </div>
            </div>
          </div>
          {mobileModelTarget && !isRec && isActive && createPortal(
            <>
              {onDeepToggle && (
                <button
                  onClick={e => { e.stopPropagation(); playUISound('deep-toggle', 0.5); onDeepToggle() }}
                  className={`flex items-center justify-center transition-all cursor-pointer p-0.5 ${
                    deepMode ? 'text-[var(--warm)]' : 'text-[var(--t3)] active:text-[var(--t1)]'
                  }`}
                  title={deepMode ? 'Briefing aktiv' : 'Briefing'}
                  aria-label="Briefing"
                >
                  <Lightbulb
                    className="w-[22px] h-[22px]"
                    fill={deepMode ? 'currentColor' : 'none'}
                    strokeWidth={deepMode ? 2 : 1.75}
                  />
                </button>
              )}
              {onDualToggle && (
                <button
                  onClick={e => { e.stopPropagation(); onDualToggle() }}
                  className={`flex items-center justify-center transition-all cursor-pointer p-0.5 ml-2 ${
                    dualActive ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)] active:text-[var(--t1)]'
                  }`}
                  title={dualActive ? `Dual mit ${dualPartner} aktiv` : `Dual mit ${dualPartner}`}
                  aria-label="Dual"
                >
                  <MessagesSquare className="w-[22px] h-[22px]" strokeWidth={1.75} />
                </button>
              )}
              {(onEngineChange || onEffortChange) && (
                <div ref={brainMenuRootRef} className="relative ml-2">
                  <button
                    onClick={e => { e.stopPropagation(); setShowBrainMenu(v => !v) }}
                    className={`flex items-center justify-center transition-all cursor-pointer p-0.5 ${
                      (effort ?? 'medium') === 'max' ? 'brain-max-pulse' : ''
                    }`}
                    style={{ color: (effort ?? 'medium') === 'max' ? undefined : effortBrainStyle(effort ?? 'medium').color }}
                    title={`${engine === 'claude' ? 'Claude Code' : 'Codex'} · ${EFFORT_LABEL[effort ?? 'medium']}`}
                    aria-label="Engine + Reasoning"
                  >
                    <EngineLogo engine={engine} size={22} />
                  </button>
                  {showBrainMenu && (
                    <div className="absolute top-full mt-2 right-0 bg-[var(--bg-2)] border border-[var(--border-f)] rounded-2xl p-1.5 z-50 shadow-[0_12px_40px_rgba(0,0,0,0.5)] min-w-[220px]">
                      {onEngineChange && (
                        <>
                          <div className="px-3 pt-1 pb-0.5 text-[12px] uppercase tracking-wide text-[var(--t3)]">Engine</div>
                          <div className="flex gap-1 px-1.5 pb-1.5">
                            {(['claude', 'codex'] as const).map(eng => {
                              const active = engine === eng
                              return (
                                <button
                                  key={eng}
                                  onClick={e => { e.stopPropagation(); if (!active) onEngineChange(eng) }}
                                  className={`flex-1 flex items-center justify-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors ${active ? 'bg-[var(--bg-3)]' : 'active:bg-[var(--bg-3)]'}`}
                                >
                                  {eng === 'claude' ? <ClaudeCodeLogo size={20} /> : <CodexLogo size={20} />}
                                  <span className="text-[15px] text-[var(--t1)]">{eng === 'claude' ? 'Claude' : 'Codex'}</span>
                                </button>
                              )
                            })}
                          </div>
                        </>
                      )}
                      {engine === 'claude' && onModelChange && (
                        <>
                          {onEngineChange && <div className="my-0.5 mx-2 border-t border-[var(--border-f)]" />}
                          <div className="px-3 pt-1 pb-0.5 text-[12px] uppercase tracking-wide text-[var(--t3)]">Modell</div>
                          {CLAUDE_MODEL_OPTIONS.map(m => {
                            const active = model === m.id || model === m.name
                            return (
                              <button
                                key={m.id}
                                onClick={e => { e.stopPropagation(); if (!active) onModelChange(m.id); setShowBrainMenu(false) }}
                                className={`flex items-center gap-3 w-full text-left px-3 py-2 rounded-lg cursor-pointer transition-colors ${active ? 'bg-[var(--bg-3)] text-[var(--t1)]' : 'text-[var(--t2)] active:bg-[var(--bg-3)]'}`}
                              >
                                <span className="text-[16px]">{m.name}</span>
                                {m.id === 'claude-fable-5' && <span className="ml-auto text-[12px] text-[var(--t3)]">1M</span>}
                              </button>
                            )
                          })}
                        </>
                      )}
                      {onEffortChange && (
                        <>
                          {(onEngineChange || onModelChange) && <div className="my-0.5 mx-2 border-t border-[var(--border-f)]" />}
                          <div className="px-3 pt-1 pb-0.5 text-[12px] uppercase tracking-wide text-[var(--t3)]">Reasoning</div>
                          {[...EFFORT_LEVELS_BY_ENGINE[engine]].reverse().map(lvl => {
                            const active = (effort ?? 'medium') === lvl
                            const lvlSty = effortBrainStyle(lvl)
                            return (
                              <button
                                key={lvl}
                                onClick={e => { e.stopPropagation(); onEffortChange(lvl); setShowBrainMenu(false) }}
                                className={`flex items-center gap-3 w-full text-left px-3 py-2 rounded-lg cursor-pointer transition-colors ${active ? 'bg-[var(--bg-3)]' : 'active:bg-[var(--bg-3)]'}`}
                              >
                                <Brain className="w-[20px] h-[20px]" strokeWidth={1.75} style={{ color: lvlSty.color }} />
                                <span className="text-[16px]" style={{ color: lvlSty.color }}>{EFFORT_LABEL[lvl]}</span>
                              </button>
                            )
                          })}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>,
            mobileModelTarget
          )}
        </>
      )
    }
    return (
      <div className="px-0 pt-0 pb-0 bg-transparent">
        {/* File previews */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-2">
            {files.map((f, i) => (
              <div key={i} className="relative flex items-center gap-1.5 bg-[var(--bg-3)] rounded-lg px-2.5 py-2 max-w-[180px]">
                {f.preview ? (
                  <img src={f.preview} alt="" className="w-7 h-7 rounded object-cover flex-shrink-0" />
                ) : f.type.startsWith('image/') ? (
                  <Image className="w-4 h-4 text-[var(--t3)] flex-shrink-0" />
                ) : (
                  <FileText className="w-4 h-4 text-[var(--t3)] flex-shrink-0" />
                )}
                <span className="text-[15px] text-[var(--t2)] truncate">{f.name}</span>
                <button onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} className="text-[var(--t3)] cursor-pointer flex-shrink-0">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,audio/*,.m4a,.mp3,.ogg,.wav,.flac,.aac,.webm,.txt,.md,.json,.csv,.pdf,.xlsx,.xlsm,.xls,.docx,.doc,.py,.js,.ts,.html,.css"
          className="hidden"
          onChange={e => { if (e.target.files?.length) { addFiles(e.target.files); e.target.value = '' } }}
        />

        <div
          ref={setComposerWrapNode}
          style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}
          className={`composer-mobile-wrap relative rounded-b-none border-t border-x-0 border-b-0 bg-[var(--bg)] px-4 pt-2 pb-[max(0px,calc(env(safe-area-inset-bottom,0px)-14px))] transition-all duration-300 ${
            mobileRecording
              ? `recording-active${mobilePaused ? ' recording-paused' : ''}`
              : (voiceClass(voice) || 'border-[var(--border-f)]')
          }`}
        >
          {(() => {
            const presenceLabels: Record<NonNullable<typeof busyKind>, string> = {
              idle: '', thinking: 'Denkt nach', writing: 'Schreibt', tool: 'Arbeitet', done: 'Fertig',
            }
            const recLabel = mobilePaused ? 'Pausiert' : 'Aufnahme'
            const s = recordingSeconds
            const recTimer = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
            // Presence übernimmt den Zeilen-Slot nur noch bei laufender Aufnahme.
            // Agent' Arbeitszeit lebt jetzt in der Chat-Live-Zeile, nicht im Composer,
            // damit der Eingabebereich ruhig bleibt.
            const showPresence = !!mobileRecording
            const isRec = !!mobileRecording
            const label = isRec ? recLabel : presenceLabels[busyKind!]
            const right = isRec ? recTimer : String(elapsed)
            return (
              <div className="relative min-h-[32px]">
                <textarea
                  ref={ref}
                  value={text}
                  onChange={e => {
                    setText(e.target.value)
                    if (ref.current) {
                      ref.current.style.height = 'auto'
                      ref.current.style.height = Math.min(ref.current.scrollHeight, 180) + 'px'
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
                  }}
                  onPaste={handlePaste}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  disabled={isRec}
                  placeholder={showPresence ? '' : `Nachricht an ${agentName}...`}
                  rows={1}
                  autoComplete="off"
                  autoCorrect="on"
                  style={{ paddingTop: 10, paddingBottom: 0 }}
                  className={`block w-full bg-transparent border-none outline-none resize-none text-[22px] text-[var(--t1)] placeholder:text-[18px] placeholder:text-[var(--t3)]/55 leading-[1.45] min-h-[32px] max-h-[180px] align-top transition-opacity ${showPresence ? 'opacity-0 pointer-events-none' : ''}`}
                />
                {showPresence && (
                  <div
                    onClick={() => { if (!isRec) ref.current?.focus() }}
                    className={`absolute inset-0 flex items-start justify-between select-none leading-[1.45] ${isRec ? '' : 'cursor-text'}`}
                    style={{ fontFamily: 'var(--font-body)', paddingTop: 10 }}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={`text-[22px] leading-[1.45] truncate ${isRec ? (mobilePaused ? 'text-[#d97757]/70' : 'status-shimmer-orange') : 'status-shimmer'}`}>
                        {label}
                      </span>
                    </span>
                    <span
                      className={`text-[22px] leading-[1.45] tabular-nums flex-shrink-0 ml-3 font-semibold ${isRec ? '' : 'status-shimmer'}`}
                      style={{
                        fontFamily: 'var(--font-heading)',
                        ...(isRec ? { color: '#d97757', opacity: 0.95 } : {}),
                      }}
                    >
                      {right}
                    </span>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Audio player — own row above buttons, never replaces them */}
          {isPlaying && onStopAudio && onAudioPlayPause && onAudioSeek && (
            <div className="flex items-center gap-2.5 pt-1 pb-1">
              <button
                onClick={e => { e.stopPropagation(); onAudioPlayPause() }}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)] transition-all cursor-pointer flex-shrink-0"
              >
                {audioPaused
                  ? <Play className="w-4 h-4" fill="currentColor" style={{ marginLeft: 1 }} />
                  : <Pause className="w-4 h-4" fill="currentColor" />
                }
              </button>
              <div
                className="flex-1 h-1 bg-[var(--bg-3)] rounded-full cursor-pointer relative min-w-[60px]"
                onClick={e => {
                  e.stopPropagation()
                  const rect = e.currentTarget.getBoundingClientRect()
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                  onAudioSeek(pct * audioDuration)
                }}
              >
                <div
                  className="absolute inset-y-0 left-0 bg-[var(--t3)] rounded-full transition-[width] duration-100"
                  style={{ width: audioDuration > 0 ? `${(audioTime / audioDuration) * 100}%` : '0%' }}
                />
              </div>
              <span className="text-[13px] text-[var(--t3)] tabular-nums flex-shrink-0">
                {formatTime(audioTime)}
              </span>
              <button
                onClick={e => { e.stopPropagation(); onStopAudio() }}
                className="flex items-center justify-center text-[var(--t3)] active:text-[var(--t1)] transition-colors cursor-pointer p-0.5 flex-shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          )}

          <div className="flex items-center justify-between pt-3">
            <div className="flex items-center gap-2 min-h-[52px]">
              {mobileRecording ? (
                <button
                  onPointerDown={e => { e.stopPropagation(); onMobileCancelRecord?.() }}
                  className="flex h-14 w-14 items-center justify-center rounded-full text-[var(--t2)] active:text-[var(--t1)] transition-all cursor-pointer flex-shrink-0"
                  title="Aufnahme verwerfen"
                >
                  <Trash2 className="w-7 h-7" />
                </button>
              ) : (
                <>
                  <button
                    onClick={e => { e.stopPropagation(); setMobileVoiceFirstCollapsed(true); ref.current?.blur() }}
                    className="flex h-11 w-11 items-center justify-center text-[var(--t3)] active:text-[var(--t1)] transition-all cursor-pointer flex-shrink-0"
                    title="Tastatur schließen"
                    aria-label="Tastatur schließen"
                  >
                    <ChevronDown className="w-7 h-7" />
                  </button>
                  {!(focused || hasContent) && (
                  <button
                    onClick={e => { e.stopPropagation(); fileInputRef.current?.click() }}
                    className="flex h-11 w-11 items-center justify-center text-[var(--t2)] active:text-[var(--t1)] transition-all cursor-pointer flex-shrink-0"
                  >
                    <Plus className="w-8 h-8" />
                  </button>
                  )}
                  {!(focused || hasContent) && onEffortChange && (() => {
                    const cur = effort ?? 'medium'
                    return (
                    <div ref={effortRootRef} className="relative">
                      <button
                        onClick={e => { e.stopPropagation(); setShowEffort(v => !v) }}
                        className={`flex h-11 w-11 items-center justify-center transition-all cursor-pointer flex-shrink-0 ${
                          cur === 'max'
                            ? 'brain-max-pulse'
                            : 'text-[var(--t2)] active:text-[var(--t1)]'
                        }`}
                        title={`Reasoning: ${EFFORT_LABEL[cur]}`}
                      >
                        <Brain className="w-7 h-7" strokeWidth={1.75} />
                      </button>
                      {showEffort && (
                        <div className="absolute bottom-full mb-2 left-0 bg-[var(--bg-2)] border border-[var(--border-f)] rounded-xl p-1 z-50 shadow-[0_12px_40px_rgba(0,0,0,0.5)] min-w-[160px]">
                          {EFFORT_LEVELS.map(lvl => {
                            const active = effort === lvl
                            const lvlSty = effortBrainStyle(lvl)
                            return (
                              <button
                                key={lvl}
                                onClick={e => { e.stopPropagation(); onEffortChange(lvl); setShowEffort(false) }}
                                className={`flex items-center w-full text-left px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                                  active ? 'bg-[var(--bg-3)]' : 'hover:bg-[var(--bg-3)]'
                                }`}
                                style={{ color: lvlSty.color }}
                              >
                                <span className="text-[16px]">{EFFORT_LABEL[lvl]}</span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                    )
                  })()}
                  {!(focused || hasContent) && onOpenSettings && (
                    <button
                      onClick={e => { e.stopPropagation(); onOpenSettings() }}
                      className="flex h-11 w-11 items-center justify-center text-[var(--t2)] active:text-[var(--t1)] transition-all cursor-pointer flex-shrink-0"
                      title="Einstellungen"
                    >
                      <SettingsIcon className="w-7 h-7" strokeWidth={1.75} />
                    </button>
                  )}
                  {!(focused || hasContent) && onEngineChange && (
                    <button
                      onClick={e => { e.stopPropagation(); onEngineChange(engine === 'claude' ? 'codex' : 'claude') }}
                      className="flex h-11 w-11 items-center justify-center transition-all cursor-pointer flex-shrink-0 text-[var(--t1)] active:text-white"
                      title={engine === 'claude' ? 'Engine: Claude Code' : 'Engine: Codex'}
                    >
                      {engine === 'claude' ? <ClaudeCodeLogo size={30} /> : <CodexLogo size={30} />}
                    </button>
                  )}
                  {!(focused || hasContent) && onDeepToggle && (
                    <button
                      onClick={e => { e.stopPropagation(); playUISound('deep-toggle', 0.5); onDeepToggle() }}
                      className={`flex h-11 w-11 items-center justify-center transition-all cursor-pointer flex-shrink-0 ${
                        deepMode ? 'text-[var(--warm)]' : 'text-[var(--t2)] active:text-[var(--t1)]'
                      }`}
                      title={deepMode ? 'Briefing aktiv' : 'Briefing'}
                    >
                      <Lightbulb
                        className="w-7 h-7"
                        fill={deepMode ? 'currentColor' : 'none'}
                        strokeWidth={deepMode ? 2 : 1.75}
                      />
                    </button>
                  )}
                  {!(focused || hasContent) && onDualToggle && (
                    <button
                      onClick={e => { e.stopPropagation(); onDualToggle() }}
                      className={`flex h-11 w-11 items-center justify-center transition-all cursor-pointer flex-shrink-0 ${
                        dualActive ? 'text-[var(--cc-orange)]' : 'text-[var(--t2)] active:text-[var(--t1)]'
                      }`}
                      title={dualActive ? `Dual mit ${dualPartner} aktiv` : `Dual mit ${dualPartner}`}
                    >
                      <MessagesSquare className="w-7 h-7" strokeWidth={1.75} />
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-2">

              {mobileRecording ? (
                <>
                  <button
                    onPointerDown={e => {
                      e.stopPropagation()
                      if (mobilePaused) onMobileResumeRecord?.(); else onMobilePauseRecord?.()
                    }}
                    className="flex h-14 w-14 items-center justify-center rounded-full border border-[var(--border-f)] text-[var(--t1)] transition-all cursor-pointer flex-shrink-0"
                    title={mobilePaused ? 'Weiter aufnehmen' : 'Aufnahme pausieren'}
                  >
                    {mobilePaused
                      ? <Mic className="w-7 h-7" />
                      : <Pause className="w-7 h-7" fill="currentColor" />
                    }
                  </button>
                  <button
                    onPointerDown={e => { e.stopPropagation(); onMobileRecord?.() }}
                    className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)] transition-all cursor-pointer flex-shrink-0"
                    title="Aufnahme senden"
                  >
                    <ArrowUp className="w-7 h-7" strokeWidth={2.5} />
                  </button>
                </>
              ) : onMobileRecord ? (
                <>
                  {/* Queue: nur sichtbar wenn der User wirklich was Neues abschicken will (busy + Content) */}
                  {busy && hasContent && (
                    <button
                      onPointerDown={e => { e.stopPropagation(); send() }}
                      disabled={disabled || isUploading}
                      className="flex h-14 w-14 items-center justify-center text-[var(--t1)] active:text-white transition-all disabled:opacity-30 disabled:cursor-default cursor-pointer flex-shrink-0"
                      title="In Queue stellen"
                    >
                      <Hourglass className="w-7 h-7" strokeWidth={2} />
                    </button>
                  )}
                  {/* Stop: kein Kreis, nur Icon — gleiche Ruhe wie der Send-Pfeil */}
                  {busy && (
                    <button
                      onPointerDown={e => { e.stopPropagation(); onCommand?.('/stop', '') }}
                      className="flex h-14 w-14 items-center justify-center text-[var(--t1)] active:text-white transition-all cursor-pointer flex-shrink-0"
                      title="Agent stoppen"
                    >
                      <Square className="w-7 h-7" fill="currentColor" />
                    </button>
                  )}
                  {/* Confirm-Haken: sanft pulsierend, nur wenn Agent auf Bestätigung wartet und nichts getippt ist */}
                  {!busy && awaitingConfirmation && !hasContent && onConfirm && (
                    <button
                      onPointerDown={e => { e.stopPropagation(); onConfirm?.() }}
                      disabled={disabled}
                      className="confirm-pulse flex h-14 w-14 items-center justify-center rounded-full border border-[var(--t1)] text-[var(--t1)] transition-all cursor-pointer flex-shrink-0"
                      title="Bestätigen"
                    >
                      <Check className="w-7 h-7" strokeWidth={2.5} />
                    </button>
                  )}
                  {/* Send-Pfeil: nur wenn nichts läuft. Mic-Button im Tastatur-Modus
                      entfernt — wer Voice will, schließt die Tastatur und nimmt den
                      Agent-Avatar im Voice-First-Composer. */}
                  {!busy && (
                    <button
                      onPointerDown={e => { e.stopPropagation(); send() }}
                      disabled={!hasContent || disabled || isUploading}
                      className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)] transition-all disabled:opacity-30 disabled:cursor-default cursor-pointer flex-shrink-0"
                      title="Senden"
                      aria-label="Senden"
                    >
                      <ArrowUp className="w-7 h-7" strokeWidth={2.25} />
                    </button>
                  )}
                </>
              ) : busy ? (
                <button
                  onPointerDown={e => { e.stopPropagation(); onCommand?.('/stop', '') }}
                  className="flex h-14 w-14 items-center justify-center text-[var(--t1)] transition-all cursor-pointer flex-shrink-0"
                  title="Agent stoppen"
                >
                  <Square className="w-7 h-7" fill="currentColor" />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pb-4 max-md:pb-1">
      <div
        className={[
          'composer-wrap bg-[var(--bg-2)] rounded-2xl cursor-text border min-h-[74px] transition-all duration-300',
          dragging ? 'is-dragging bg-[rgba(224,122,79,0.05)]' : '',
          isActive ? 'is-active' : 'is-inactive',
          isActive && focused ? 'is-focused' : '',
          isActive ? voiceClass(voice) : '',
        ].filter(Boolean).join(' ')}
        onClick={() => ref.current?.focus()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* File previews */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            {files.map((f, i) => (
              <div key={i} className="relative group/file flex items-center gap-2 bg-[var(--bg-2)] border border-[var(--border)] rounded-xl px-3 py-2 max-w-[200px]">
                {f.preview ? (
                  <img src={f.preview} alt="" className="w-8 h-8 rounded-lg object-cover flex-shrink-0" />
                ) : f.type.startsWith('image/') ? (
                  <Image className="w-4 h-4 text-[var(--t3)] flex-shrink-0" />
                ) : (
                  <FileText className="w-4 h-4 text-[var(--t3)] flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-[14px] text-[var(--t2)] truncate">{f.name}</div>
                  <div className="text-[12px] text-[var(--t3)]">
                    {f.uploading ? 'Hochladen...' : formatSize(f.size)}
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); removeFile(i) }}
                  className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-[var(--bg-3)] border border-[var(--border-f)] flex items-center justify-center cursor-pointer hover:bg-[var(--bg-2)] hover:text-[var(--t1)] text-[var(--t2)] shadow-sm transition-colors"
                  title="Anhang entfernen"
                  aria-label="Anhang entfernen"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Slash command autocomplete */}
        {slash && filteredCommands.length > 0 && (
          <div className="mx-4 mt-3 bg-[var(--bg-2)] border border-[var(--border-f)] rounded-xl p-1 z-50 shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
            {filteredCommands.map((c, i) => (
              <button
                key={c.cmd}
                onMouseDown={e => { e.preventDefault(); selectSlashCommand(c) }}
                className={`flex items-center gap-3 w-full text-left text-[15px] px-3 py-2 rounded-lg cursor-pointer transition-all ${
                  i === slash.index ? 'bg-[var(--bg-3)] text-[var(--t1)]' : 'text-[var(--t2)] hover:bg-[var(--bg-3)]'
                }`}
              >
                <span className="font-mono text-[var(--warm)]">{c.cmd}</span>
                <span className="text-[var(--t3)]">{c.label}</span>
                {c.hint && <span className="text-[12px] font-mono text-[var(--t3)] ml-auto">{c.hint}</span>}
              </button>
            ))}
          </div>
        )}

        {/* Mention autocomplete */}
        {mention && filteredAgents.length > 0 && (
          <div className="mx-4 mt-3 bg-[var(--bg-2)] border border-[var(--border-f)] rounded-xl p-1 z-50 shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
            {filteredAgents.map((a, i) => (
              <button
                key={a.id}
                onMouseDown={e => { e.preventDefault(); selectMention(a.id) }}
                className={`flex items-center gap-2 w-full text-left text-[15px] px-3 py-2 rounded-lg cursor-pointer transition-all ${
                  i === mention.index ? 'bg-[var(--bg-3)] text-[var(--t1)]' : 'text-[var(--t2)] hover:bg-[var(--bg-3)]'
                }`}
              >
                <span className="text-[13px] font-mono text-[var(--t3)]">@</span>
                {a.name}
              </button>
            ))}
          </div>
        )}

        {/* Top row: textarea left, model+time right.
            Presence übernimmt den Textarea-Slot wenn Agent arbeitet und der User
            nicht selbst gerade tippt — Klick auf Presence fokussiert die Textarea zurück. */}
        <div className="composer-top px-3.5 max-md:px-5 pt-3 pb-0.5">
          {(() => {
            return (
          <div className="flex items-start gap-2">
            <div className="flex-1 relative min-w-0">
            <textarea
              ref={ref}
              value={text}
              onChange={e => {
                setText(e.target.value)
                detectMention(e.target.value, e.target.selectionStart)
                detectSlash(e.target.value)
                if (ref.current) {
                  ref.current.style.height = 'auto'
                  ref.current.style.height = Math.min(ref.current.scrollHeight, 180) + 'px'
                }
              }}
              onKeyDown={e => {
                if (handleSlashKeyDown(e)) return
                if (handleMentionKeyDown(e)) return
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
              }}
              onPaste={handlePaste}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder={dragging ? 'Datei hier ablegen...' : `Nachricht an ${agentName}...`}
              rows={1}
              className="block w-full bg-transparent border-none outline-none resize-none text-[14px] text-[var(--t2)] placeholder:text-[var(--t3)]/50 leading-[1.55] min-h-[22px] max-h-[180px] transition-opacity"
            />
            </div>
            {contextTokens > 0 && (
              <span className="text-[12px] text-[var(--t3)]/50 whitespace-nowrap mt-0.5 flex-shrink-0 flex items-center gap-1.5">
                {(() => {
                  const limit = contextWindow || defaultContextWindow(engine)
                  const pct = Math.min(Math.round((contextTokens / limit) * 100), 100)
                  if (pct <= 50) return null
                  const color = pct > 80 ? 'var(--red, #e55)' : 'var(--warm, #c9a)'
                  return (
                    <span style={{ color }} title={`${formatTokens(contextTokens)} / ${formatTokens(limit)} Tokens`}>
                      {pct}%
                    </span>
                  )
                })()}
              </span>
            )}
          </div>
            )
          })()}
        </div>

        {/* Bottom row: player replaces icons when audio is playing */}
        <div className={`composer-bottom ${showDesktopComposerTools ? 'is-visible' : 'is-resting'} flex items-center gap-2.5 px-3.5 max-md:px-5 pb-2.5 pt-0.5 h-[32px]`}>
          {isPlaying && onStopAudio && onAudioPlayPause && onAudioSeek ? (<>
            <button
              onClick={e => { e.stopPropagation(); onAudioPlayPause() }}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)] transition-all hover:bg-white cursor-pointer flex-shrink-0"
              title={audioPaused ? 'Weiter' : 'Pause'}
              aria-label={audioPaused ? 'Weiter' : 'Pause'}
            >
              {audioPaused
                ? <Play className="w-3.5 h-3.5" fill="currentColor" style={{ marginLeft: 1 }} />
                : <Pause className="w-3.5 h-3.5" fill="currentColor" />
              }
            </button>
            <span className="text-[12px] text-[var(--t3)] tabular-nums flex-shrink-0 w-8 text-right">
              {formatTime(audioTime)}
            </span>
            <input
              type="range"
              min={0}
              max={audioDuration || 0}
              step={0.1}
              value={Math.min(audioTime, audioDuration || audioTime || 0)}
              onChange={e => onAudioSeek(Number(e.target.value))}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
              className="audio-scrubber flex-1 min-w-[80px]"
              style={{ ['--pct' as string]: `${audioDuration > 0 ? Math.min(100, (audioTime / audioDuration) * 100) : 0}%` }}
              aria-label="Audio-Position"
            />
            <span className="text-[12px] text-[var(--t3)] tabular-nums flex-shrink-0 w-8">
              {formatTime(audioDuration)}
            </span>
            <button
              onClick={e => { e.stopPropagation(); onStopAudio() }}
              className="flex items-center justify-center text-[var(--t3)] hover:text-[var(--t1)] transition-colors cursor-pointer p-0.5 flex-shrink-0"
              title="Audio stoppen"
              aria-label="Audio stoppen"
            >
              <X className={headerControlIconClass} />
            </button>
          </>) : (<>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,audio/*,.m4a,.mp3,.ogg,.wav,.flac,.aac,.webm,.txt,.md,.json,.csv,.pdf,.xlsx,.xlsm,.xls,.docx,.doc,.py,.js,.ts,.html,.css"
              className="hidden"
              onChange={e => { if (e.target.files?.length) { addFiles(e.target.files); e.target.value = '' } }}
            />
            <button
              onClick={e => { e.stopPropagation(); fileInputRef.current?.click() }}
              className="flex items-center justify-center text-[var(--t3)] hover:text-[var(--t2)] transition-all cursor-pointer p-0.5"
              title="Datei anhängen"
            >
              <Paperclip className={headerControlIconClass} />
            </button>

            {(() => {
              const cur = effort ?? 'medium'
              const modelLabel = (engine === 'claude' ? claudeModelLabel(model) : model) || 'Modell'
              const modelInTopBar = (!!mobile && !!mobileModelTarget) || (!mobile && !!headerControlsTarget)
              // Dropdown-Richtung: oben nach unten, im Composer-Footer nach oben.
              const dropdownPos = modelInTopBar ? 'top-full mt-2 right-0' : 'bottom-full mb-2 left-0'
              const modelMenuNode = (onEffortChange || onEngineChange) ? (
                <div ref={effortRootRef} className="relative flex items-center">
                  <button
                    onClick={e => { e.stopPropagation(); setShowEffort(v => !v) }}
                    className={`flex items-center justify-center transition-all cursor-pointer p-0.5 ${
                      cur === 'max'
                        ? 'brain-max-pulse'
                        : 'text-[var(--t3)] hover:text-[var(--t2)]'
                    }`}
                    title={`${engine === 'claude' ? 'Claude Code' : 'Codex'} • ${modelLabel} • ${EFFORT_LABEL[cur]}`}
                  >
                    <EngineLogo engine={engine} size={headerControlLogoSize} />
                  </button>
                  {showEffort && (
                    <div className={`absolute ${dropdownPos} bg-[var(--bg-2)] border border-[var(--border-f)] rounded-xl p-1 z-50 shadow-[0_12px_40px_rgba(0,0,0,0.5)] min-w-[180px]`}>
                      {onEngineChange && (
                        <>
                          <div className="px-3 pt-1.5 pb-1 text-[13px] tracking-[0.02em] text-[var(--t3)]/70 font-normal">
                            Engine
                          </div>
                          {(['claude', 'codex'] as const).map(eng => {
                            const active = engine === eng
                            return (
                              <button
                                key={eng}
                                onClick={e => { e.stopPropagation(); if (!active) onEngineChange(eng) }}
                                className={`flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-lg cursor-pointer transition-colors text-[15px] ${
                                  active ? 'bg-[var(--bg-3)] text-[var(--t1)]' : 'text-[var(--t2)] hover:bg-[var(--bg-3)]'
                                }`}
                              >
                                {eng === 'claude' ? <ClaudeCodeLogo size={16} /> : <CodexLogo size={16} />}
                                <span>{eng === 'claude' ? 'Claude Code' : 'Codex'}</span>
                              </button>
                            )
                          })}
                          {onEffortChange && <div className="h-px bg-[var(--border-f)] my-1 mx-2" />}
                        </>
                      )}
                      {engine === 'claude' && onModelChange && (
                        <>
                          <div className="px-3 pt-1.5 pb-1 text-[13px] tracking-[0.02em] text-[var(--t3)]/70 font-normal">
                            Modell
                          </div>
                          {CLAUDE_MODEL_OPTIONS.map(m => {
                            const active = model === m.id || model === m.name
                            return (
                              <button
                                key={m.id}
                                onClick={e => { e.stopPropagation(); if (!active) onModelChange(m.id); setShowEffort(false) }}
                                className={`flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-lg cursor-pointer transition-colors text-[15px] ${
                                  active ? 'bg-[var(--bg-3)] text-[var(--t1)]' : 'text-[var(--t2)] hover:bg-[var(--bg-3)]'
                                }`}
                              >
                                <span>{m.name}</span>
                                {m.id === 'claude-fable-5' && <span className="ml-auto text-[12px] text-[var(--t3)]/70">1M</span>}
                              </button>
                            )
                          })}
                          {onEffortChange && <div className="h-px bg-[var(--border-f)] my-1 mx-2" />}
                        </>
                      )}
                      {onEffortChange && (
                        <>
                          <div className="px-3 pt-1.5 pb-1 text-[13px] tracking-[0.02em] text-[var(--t2)] font-medium">
                            {modelLabel} <span className="text-[var(--t3)]/70 font-normal">Reasoning</span>
                          </div>
                          {EFFORT_LEVELS_BY_ENGINE[engine].map(lvl => {
                            const active = effort === lvl
                            const lvlSty = effortBrainStyle(lvl)
                            return (
                              <button
                                key={lvl}
                                onClick={e => { e.stopPropagation(); onEffortChange(lvl); setShowEffort(false) }}
                                className={`flex items-center w-full text-left px-3 py-1.5 rounded-lg cursor-pointer transition-colors text-[15px] ${
                                  active ? 'bg-[var(--bg-3)]' : 'hover:bg-[var(--bg-3)]'
                                }`}
                                style={{ color: lvlSty.color }}
                              >
                                {EFFORT_LABEL[lvl]}
                              </button>
                            )
                          })}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ) : null
              const togglesNode = (
                <>
                  {onStartVoice && voiceReady && (
                    <button
                      onClick={e => { e.stopPropagation(); onStartVoice?.() }}
                      className={`flex items-center justify-center transition-all cursor-pointer p-0.5 ${
                        voice.active ? 'text-[#d97757]' : 'text-[var(--t3)] hover:text-[var(--t2)]'
                      }`}
                      title={voice.active ? `${agentName}-Voice beenden` : `Mit ${agentName} sprechen`}
                    >
                      <Mic className={headerControlIconClass} strokeWidth={1.75} fill="none" />
                    </button>
                  )}
                  {onDeepToggle && (
                    <button
                      onClick={e => { e.stopPropagation(); playUISound('deep-toggle', 0.5); onDeepToggle() }}
                      className={`flex items-center justify-center transition-all cursor-pointer p-0.5 ${
                        deepMode ? 'text-[var(--warm)]' : 'text-[var(--t3)] hover:text-[var(--t2)]'
                      }`}
                      title={deepMode ? 'Briefing aktiv — nächste Antworten ausführlich' : 'Briefing — ausführliche Antworten mit voller Struktur'}
                    >
                      <Lightbulb
                        className={headerControlIconClass}
                        fill={deepMode ? 'currentColor' : 'none'}
                        strokeWidth={deepMode ? 2 : 1.75}
                      />
                    </button>
                  )}
                  {onDualToggle && (
                    <button
                      onClick={e => { e.stopPropagation(); onDualToggle() }}
                      className={`flex items-center justify-center transition-all cursor-pointer p-0.5 ${
                        dualActive ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)] hover:text-[var(--t2)]'
                      }`}
                      title={dualActive ? `Dual mit ${dualPartner} aktiv` : `Dual mit ${dualPartner}`}
                    >
                      <MessagesSquare className={headerControlIconClass} strokeWidth={1.75} />
                    </button>
                  )}
                  {!mobileModelTarget && modelMenuNode}
                </>
              )
              if (!mobile && headerControlsTarget) return createPortal(<>{togglesNode}</>, headerControlsTarget)
              return (
                <>
                  {togglesNode}
                  {mobileModelTarget && modelMenuNode ? createPortal(modelMenuNode, mobileModelTarget) : null}
                </>
              )
            })()}

            {/* Confirm-Haken: sanft pulsierend, neben Send wenn Agent auf Bestätigung wartet */}
            {!busy && awaitingConfirmation && !hasContent && onConfirm && (
              <button
                onClick={e => { e.stopPropagation(); onConfirm?.() }}
                disabled={disabled}
                className="confirm-pulse flex h-7 w-7 items-center justify-center rounded-full border border-[var(--t1)] text-[var(--t1)] transition-all hover:bg-[var(--t1)] hover:text-[var(--bg-1)] cursor-pointer ml-auto"
                title="Bestätigen — schickt 'Mach.'"
              >
                <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
              </button>
            )}
            {busy ? (
              <button
                onClick={e => { e.stopPropagation(); onCommand?.('/stop', '') }}
                className={`flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)] transition-all hover:brightness-110 cursor-pointer ${!hasContent && awaitingConfirmation && onConfirm ? '' : 'ml-auto'}`}
              >
                <Square className="w-3 h-3" fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!hasContent || disabled || isUploading}
                className={`flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-fg)] transition-all hover:bg-white disabled:opacity-20 disabled:cursor-default cursor-pointer ${!hasContent && awaitingConfirmation && onConfirm ? '' : 'ml-auto'}`}
              >
                <ArrowUp className="w-3.5 h-3.5" strokeWidth={2.5} />
              </button>
            )}
          </>)}
        </div>
      </div>
    </div>
  )
}

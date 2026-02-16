export type ViewMode = 'flat' | 'grouped'
export type SortPreset = 'status' | 'startAsc' | 'startDesc' | 'lastActivityDesc'
export type GroupSortPreset = 'waiting' | 'path'

export interface Workspace {
  id: string
  title: string
  cwd: string
  profileId?: string
  sortOrder?: number
  lastActiveTs?: number
}

export type SessionStatus = 'working' | 'waiting' | 'ended' | 'unknown'

export interface ClaudeHookEvent {
  ts: number
  event: string
  event_id?: string

  source?: string
  tabby_session?: string
  terminal_id?: string
  host_pid?: number
  cwd?: string
  message?: string
  session_id?: string
  title?: string
  notification_type?: string
  transcript_path?: string
  permission_mode?: string
  tool_name?: string
}

export type ClaudeTodoStatus = 'pending' | 'in_progress' | 'completed'

export interface ClaudeTodo {
  content: string
  status?: ClaudeTodoStatus
}

export interface ClaudeSession {
  key: string
  sessionId?: string
  source?: string
  tabbySession?: string
  terminalId?: string
  hostPid?: number
  transcriptPath?: string
  cwd?: string
  title?: string

  startTs?: number
  lastEventTs?: number
  lastEvent?: string

  lastToolTs?: number
  lastToolName?: string

  waitingSinceTs?: number
  endedTs?: number

  status: SessionStatus
  lastMessage?: string
}

export interface UsageSummary {
  statsAvailable?: boolean
  lastComputedDate: string
  totalSessions: number
  totalMessages: number
  totalToolCalls?: number
  usage5h?: {
    used: number
    limit: number
    resetsAt?: string | null
  }
  usageWeek?: {
    used: number
    limit: number
    resetsAt?: string | null
  }
  today?: {
    date: string
    messageCount: number
    sessionCount: number
    toolCallCount: number
  }
  plan?: {
    subscriptionType?: string | null
    rateLimitTier?: string | null
    expiresAt?: number | null
    scopes?: string[] | null
  }
  sessionLimitResetHint?: string | null
}

export interface SavedTerminal {
  sessionId: string
  title: string
}

export interface SessionGroup {
  cwd: string
  projectName: string
  sessions: ClaudeSession[]
  waitingCount: number
  oldestWaitingTs?: number
  lastActivityTs?: number
}

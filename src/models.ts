export type SortPreset = 'status' | 'startAsc' | 'startDesc' | 'lastActivityDesc'
export type GroupSortPreset = 'flat' | 'waiting' | 'path' | 'none'

export interface Workspace {
  id: string
  title: string
  cwd: string
  profileId?: string
  sortOrder?: number
  lastActiveTs?: number
  useDockerSandbox?: boolean
  /** Custom Docker image for this workspace. Falls back to global default if empty. */
  dockerImage?: string
  mountClaudeDir?: boolean
  dangerouslySkipPermissions?: boolean
  /** Ports to forward from container localhost to host (via socat). */
  forwardPorts?: number[]
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
  hook_type?: 'command' | 'prompt' | 'agent'

  // Bidirectional permission request (PermissionRequest hook keeps socket open)
  awaiting_response?: boolean   // true when hook keeps socket open for response
  request_id?: string           // UUID for correlating request/response

  // Tool details (PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest)
  tool_input?: string           // JSON-summarized tool input (file_path, command, etc.)
  tool_response?: string        // truncated tool response (PostToolUse)
  tool_use_id?: string

  // Error details (PostToolUseFailure)
  error?: string
  is_interrupt?: boolean

  // User prompt (UserPromptSubmit)
  prompt?: string

  // Session metadata (SessionStart)
  model?: string
  agent_type?: string           // named agent (--agent <name>)

  // Subagent lifecycle (SubagentStart, SubagentStop)
  agent_id?: string
  subagent_type?: string        // Bash, Explore, Plan, custom
  agent_transcript_path?: string
  stop_hook_active?: boolean

  // Task (TaskCompleted)
  task_id?: string
  task_subject?: string
  task_description?: string

  // Team (TeammateIdle, TaskCompleted)
  teammate_name?: string
  team_name?: string

  // Compact (PreCompact)
  trigger?: string              // manual | auto
  custom_instructions?: string

  // Session end (SessionEnd)
  reason?: string               // clear | logout | prompt_input_exit | other
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

  /** Number of currently running subagents (from SubagentStart/Stop). */
  activeSubagents?: number
  /** Tool name awaiting permission (from PermissionRequest, cleared on next tool event). */
  permissionPending?: string
  /** Active request_id for bidirectional permission response (buttons visible when set). */
  permissionRequestId?: string
  /** Human-readable permission detail: "$ rm -rf dist/", "Write .env.production". */
  permissionDetail?: string
  /** Active request_id when SubagentStop hook is holding. */
  subagentStopRequestId?: string
  /** Active request_id when TeammateIdle hook is holding. */
  teammateIdleRequestId?: string
  /** Active request_id when TaskCompleted hook is holding. */
  taskCompletedRequestId?: string
  /** Task subject for the pending TaskCompleted action. */
  taskCompletedDetail?: string
  /** Last tool that failed (from PostToolUseFailure, cleared on next successful tool). */
  lastFailedTool?: string
  /** Number of context compactions so far (from PreCompact). */
  compactCount?: number
  /** Number of tasks completed in this session (from TaskCompleted). */
  tasksCompleted?: number
  /** Whether a teammate is idle (from TeammateIdle). */
  teammateIdle?: boolean
  /** Last hook handler type that processed an event (command / prompt / agent). */
  lastHookType?: 'command' | 'prompt' | 'agent'

  // --- Extended activity tracking ---

  /** Formatted current activity: "Running: npm test", "Editing: src/index.ts", etc. */
  currentActivity?: string
  /** Model identifier from SessionStart (e.g. "claude-opus-4-6"). */
  model?: string
  /** Named agent type from SessionStart --agent flag. */
  agentType?: string
  /** User's last prompt text (from UserPromptSubmit, truncated). */
  lastPrompt?: string
  /** Last error message from PostToolUseFailure. */
  lastError?: string
  /** Whether last failure was a user interrupt. */
  isInterrupt?: boolean
  /** Reason the session ended (from SessionEnd: clear/logout/exit/other). */
  endReason?: string
  /** Team name (from TeammateIdle/TaskCompleted). */
  teamName?: string
  /** Teammate name (from TeammateIdle/TaskCompleted). */
  teammateName?: string
  /** Subject of the last completed task (from TaskCompleted). */
  lastTaskSubject?: string
  /** Last compact trigger: "manual" | "auto" (from PreCompact). */
  compactTrigger?: string
  /** Details of active subagent (agent_type from SubagentStart). */
  lastSubagentType?: string
  /** Truncated output from the last completed tool call (PostToolUse). */
  lastToolResponse?: string
  /** Active subagent transcript paths for mini-todo extraction. */
  subagentTranscripts?: Array<{ type: string, path: string, agentId?: string }>
  /** Description of the last completed task (from TaskCompleted). */
  taskDescription?: string
  /** Permission mode: default/plan/acceptEdits/dontAsk/bypassPermissions. */
  permissionMode?: string
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
  workingCount: number
  oldestWaitingTs?: number
  lastActivityTs?: number
}

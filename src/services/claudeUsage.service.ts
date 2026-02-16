import { Injectable } from '@angular/core'
import { BehaviorSubject } from 'rxjs'

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as https from 'https'
import { URLSearchParams } from 'url'

import { UsageSummary } from '../models'

function getStatsPath (): string {
  return path.join(os.homedir(), '.claude', 'stats-cache.json')
}

function getCredentialsPath (): string {
  return path.join(os.homedir(), '.claude', '.credentials.json')
}

function getHistoryPath (): string {
  return path.join(os.homedir(), '.claude', 'history.jsonl')
}

@Injectable({ providedIn: 'root' })
export class ClaudeUsageService {
  readonly summary$ = new BehaviorSubject<UsageSummary | null>(null)
  readonly statsPath = getStatsPath()
  readonly credentialsPath = getCredentialsPath()
  readonly historyPath = getHistoryPath()
  readonly usageURL = 'https://api.anthropic.com/api/oauth/usage'
  readonly tokenURL = 'https://platform.claude.com/v1/oauth/token'
  readonly clientID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

  private timer?: any
  private lastStatsMtimeMs = 0
  private lastCredsMtimeMs = 0
  private lastHistoryMtimeMs = 0

  private cachedStats: Partial<UsageSummary> | null = null
  private cachedPlan: UsageSummary['plan'] | null = null
  private cachedLimitHint: string | null = null
  private cachedRemoteUsage: {
    usage5h?: { used: number, limit: number }
    usageWeek?: { used: number, limit: number }
  } | null = null

  private remoteNextPollAt = 0
  private remotePollInFlight = false

  constructor () {
    this.start()
  }

  private start (): void {
    this.timer = setInterval(() => {
      this.tick().catch(() => null)
    }, 30_000)
    this.tick().catch(() => null)
  }

  private readJsonFile (filePath: string): any | null {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      return null
    }
  }

  private readCredentials (): any | null {
    return this.readJsonFile(this.credentialsPath)?.claudeAiOauth ?? null
  }

  private async postForm (url: string, form: URLSearchParams, headers: Record<string, string>): Promise<{ status: number, body: string }> {
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...headers,
        },
      }, res => {
        const chunks: Buffer[] = []
        res.on('data', d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      })
      req.on('error', reject)
      req.write(form.toString())
      req.end()
    })
  }

  private async getJSON (url: string, headers: Record<string, string>): Promise<{ status: number, body: any }> {
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'GET', headers }, res => {
        const chunks: Buffer[] = []
        res.on('data', d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let body: any = null
          try { body = JSON.parse(raw) } catch { body = null }
          resolve({ status: res.statusCode ?? 0, body })
        })
      })
      req.on('error', reject)
      req.end()
    })
  }

  private saveCredentials (oauth: any): void {
    try {
      fs.writeFileSync(this.credentialsPath, JSON.stringify({ claudeAiOauth: oauth }))
    } catch { }
  }

  private isExpired (oauth: any): boolean {
    const expiresAt = Number(oauth?.expiresAt ?? 0)
    if (!expiresAt) return true
    return Date.now() >= expiresAt
  }

  private async refreshAccessToken (oauth: any): Promise<any | null> {
    if (!oauth?.refreshToken) {
      return null
    }
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: this.clientID,
    })

    const resp = await this.postForm(this.tokenURL, form, {
      'User-Agent': 'claude-code/2.1.37',
      'anthropic-beta': 'oauth-2025-04-20',
    }).catch(() => null as any)
    if (!resp || resp.status !== 200) {
      return null
    }

    let parsed: any = null
    try { parsed = JSON.parse(resp.body) } catch { parsed = null }
    if (!parsed?.access_token) {
      return null
    }

    const next = {
      ...oauth,
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token || oauth.refreshToken,
      expiresAt: Date.now() + (Number(parsed.expires_in ?? 0) * 1000),
    }
    this.saveCredentials(next)
    return next
  }

  private parseBucket (bucket: any): { used: number, limit: number, resetsAt?: string | null } | null {
    if (!bucket || typeof bucket !== 'object') {
      return null
    }
    const u = Number(bucket.utilization)
    if (!Number.isFinite(u)) {
      return null
    }
    // API returns 0..100 in claude-notify; tolerate both scales.
    // Use strict < 1: u=1 is "1 %" (percentage), not "fraction 1.0 = 100 %".
    let pct: number
    if (u >= 0 && u < 1) {
      pct = u * 100
    } else if (u >= 0 && u <= 100) {
      pct = u
    } else {
      return null
    }
    const resetsAt = typeof bucket.resets_at === 'string' ? bucket.resets_at
      : typeof bucket.expires_at === 'string' ? bucket.expires_at
        : null
    return { used: pct, limit: 100, resetsAt }
  }

  private async pollRemoteUsageIfDue (): Promise<void> {
    if (this.remotePollInFlight) {
      return
    }
    if (Date.now() < this.remoteNextPollAt) {
      return
    }

    this.remotePollInFlight = true
    try {
      let oauth = this.readCredentials()
      if (!oauth?.accessToken) {
        this.cachedRemoteUsage = null
        this.remoteNextPollAt = Date.now() + 60_000
        return
      }

      if (this.isExpired(oauth)) {
        const refreshed = await this.refreshAccessToken(oauth)
        if (refreshed) {
          oauth = refreshed
        }
      }

      const api = await this.getJSON(this.usageURL, {
        Authorization: `Bearer ${oauth.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.37',
        'anthropic-beta': 'oauth-2025-04-20',
      }).catch(() => null as any)

      if (!api || api.status !== 200 || !api.body || typeof api.body !== 'object') {
        // Soft-fail: keep old value and retry later.
        this.remoteNextPollAt = Date.now() + 2 * 60_000
        return
      }

      const five = this.parseBucket(api.body.five_hour)
      const week = this.parseBucket(api.body.seven_day)
      this.cachedRemoteUsage = {
        usage5h: five ?? undefined,
        usageWeek: week ?? undefined,
      }
      this.remoteNextPollAt = Date.now() + 60_000
    } finally {
      this.remotePollInFlight = false
    }
  }

  private updatePlanCache (): void {
    let stat: fs.Stats
    try {
      stat = fs.statSync(this.credentialsPath)
    } catch {
      this.cachedPlan = null
      return
    }
    if (stat.mtimeMs === this.lastCredsMtimeMs && this.cachedPlan) {
      return
    }
    this.lastCredsMtimeMs = stat.mtimeMs

    const raw = this.readJsonFile(this.credentialsPath)
    const oauth = raw?.claudeAiOauth
    if (!oauth || typeof oauth !== 'object') {
      this.cachedPlan = null
      return
    }

    // Never expose tokens. Only surface plan/tier metadata.
    const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.filter((s: any) => typeof s === 'string') : null
    this.cachedPlan = {
      subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
      rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null,
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
      scopes,
    }
  }

  private extractLimitResetHintFromHistoryTail (tail: string): string | null {
    const idx = tail.lastIndexOf('Session limit reached')
    if (idx === -1) {
      return null
    }
    const snippet = tail.slice(idx, Math.min(tail.length, idx + 250))
    const m = snippet.match(/resets\\s+([^\"\\r\\n]+)/i)
    if (!m) {
      return 'Session limit reached'
    }
    return `Session limit reached (resets ${m[1].trim()})`
  }

  private updateLimitHintCache (): void {
    let stat: fs.Stats
    try {
      stat = fs.statSync(this.historyPath)
    } catch {
      this.cachedLimitHint = null
      return
    }
    if (stat.mtimeMs === this.lastHistoryMtimeMs && this.cachedLimitHint !== null) {
      return
    }
    this.lastHistoryMtimeMs = stat.mtimeMs

    // Tail read to avoid scanning huge history files.
    const tailBytes = 512 * 1024
    const start = Math.max(0, stat.size - tailBytes)
    const fd = fs.openSync(this.historyPath, 'r')
    try {
      const buf = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      const text = buf.toString('utf8')
      this.cachedLimitHint = this.extractLimitResetHintFromHistoryTail(text)
    } catch {
      this.cachedLimitHint = null
    } finally {
      try { fs.closeSync(fd) } catch { }
    }
  }

  private updateStatsCache (): void {
    let stat: fs.Stats
    try {
      stat = fs.statSync(this.statsPath)
    } catch {
      this.cachedStats = null
      return
    }
    if (stat.mtimeMs === this.lastStatsMtimeMs && this.cachedStats) {
      return
    }
    this.lastStatsMtimeMs = stat.mtimeMs

    const raw = this.readJsonFile(this.statsPath)
    if (!raw || typeof raw !== 'object') {
      this.cachedStats = null
      return
    }

    const dailyActivity = Array.isArray(raw.dailyActivity) ? raw.dailyActivity : []
    const today = dailyActivity.length ? dailyActivity[dailyActivity.length - 1] : null
    this.cachedStats = {
      statsAvailable: true,
      lastComputedDate: raw.lastComputedDate ?? '',
      totalSessions: raw.totalSessions ?? 0,
      totalMessages: raw.totalMessages ?? 0,
      totalToolCalls: (dailyActivity as any[]).reduce((acc, x) => acc + (x.toolCallCount ?? 0), 0),
      today: today ? {
        date: today.date ?? '',
        messageCount: today.messageCount ?? 0,
        sessionCount: today.sessionCount ?? 0,
        toolCallCount: today.toolCallCount ?? 0,
      } : undefined,
    }
  }

  private async tick (): Promise<void> {
    await this.pollRemoteUsageIfDue()

    this.updatePlanCache()
    this.updateLimitHintCache()
    this.updateStatsCache()

    const stats: Partial<UsageSummary> = this.cachedStats ?? {
      statsAvailable: false,
      lastComputedDate: '',
      totalSessions: 0,
      totalMessages: 0,
      totalToolCalls: 0,
      today: undefined,
    }

    const summary: UsageSummary = {
      lastComputedDate: stats.lastComputedDate ?? '',
      totalSessions: stats.totalSessions ?? 0,
      totalMessages: stats.totalMessages ?? 0,
      totalToolCalls: stats.totalToolCalls ?? 0,
      usage5h: this.cachedRemoteUsage?.usage5h,
      usageWeek: this.cachedRemoteUsage?.usageWeek,
      today: stats.today,
      statsAvailable: stats.statsAvailable ?? false,
      plan: this.cachedPlan ?? undefined,
      sessionLimitResetHint: this.cachedLimitHint ?? undefined,
    }

    // Avoid unnecessary UI churn.
    const prev = this.summary$.value
    if (prev && JSON.stringify(prev) === JSON.stringify(summary)) {
      return
    }
    this.summary$.next(summary)
  }
}

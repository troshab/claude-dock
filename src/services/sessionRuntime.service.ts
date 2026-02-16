import { Injectable, Injector } from '@angular/core'
import { BehaviorSubject } from 'rxjs'

import * as os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'

import { ClaudeSession } from '../models'
import { ClaudeEventsService } from './claudeEvents.service'
import { TabbyDebugService } from './tabbyDebug.service'

const execFileAsync = promisify(execFile)

export interface SessionRuntimeStat {
  pid: number
  processName?: string
  memoryBytes?: number
  cpuPercent?: number
  running: boolean
  sampledAt: number
}

export interface SystemResourceStat {
  totalMemoryBytes: number
  freeMemoryBytes: number
  usedMemoryPercent: number
  cpuCores: number
  cpuLoadPercent: number
}

type Snapshot = {
  pid: number
  processName?: string
  memoryBytes?: number
  cpuSeconds?: number
  cpuPercentDirect?: number
}

@Injectable({ providedIn: 'root' })
export class SessionRuntimeService {
  readonly stats$ = new BehaviorSubject<Record<number, SessionRuntimeStat>>({})
  readonly system$ = new BehaviorSubject<SystemResourceStat | null>(null)

  private events: ClaudeEventsService
  private debug: TabbyDebugService

  private timer?: any
  private trackedPids = new Set<number>()
  private prevCpu = new Map<number, { ts: number, cpuSeconds: number }>()
  private lastSignature = ''
  private prevCpuTimes: { idle: number, total: number } | null = null

  constructor (injector: Injector) {
    this.events = injector.get(ClaudeEventsService)
    this.debug = injector.get(TabbyDebugService)

    this.events.sessions$.subscribe(sessions => {
      this.updateTrackedPids(sessions ?? [])
    })

    this.start()
  }

  private start (): void {
    const pollMs = 2000
    this.debug.log('runtime.polling.start', { poll_ms: pollMs, platform: process.platform })
    this.timer = setInterval(() => {
      this.tick().catch(() => null)
    }, pollMs)
    this.tick().catch(() => null)
  }

  private updateTrackedPids (sessions: ClaudeSession[]): void {
    const next = new Set<number>()
    for (const s of sessions) {
      const pid = Number(s.hostPid)
      if (Number.isFinite(pid) && pid > 0) {
        next.add(pid)
      }
    }
    this.trackedPids = next
  }

  private signature (stats: Record<number, SessionRuntimeStat>): string {
    return Object.values(stats)
      .sort((a, b) => a.pid - b.pid)
      .map(x => `${x.pid}|${x.running ? 1 : 0}|${Math.round(x.cpuPercent ?? 0)}|${Math.round((x.memoryBytes ?? 0) / 1048576)}`)
      .join(',')
  }

  private parseJSON (s: string): any | null {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }

  private async readWindowsSnapshots (pids: number[]): Promise<Map<number, Snapshot>> {
    const map = new Map<number, Snapshot>()
    if (!pids.length) {
      return map
    }

    const safeIds = pids.filter(x => Number.isFinite(x) && x > 0).map(x => Math.floor(x))
    if (!safeIds.length) {
      return map
    }

    const script = `$ids = @(${safeIds.join(',')}); Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id, CPU, WorkingSet64, ProcessName | ConvertTo-Json -Depth 4 -Compress`

    const result = await execFileAsync('powershell', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }).catch((e: any) => {
      this.debug.log('runtime.windows.exec_failed', {
        error: String(e?.message ?? e).slice(0, 400),
        stderr: String(e?.stderr ?? '').slice(0, 400),
        code: e?.code ?? null,
        pids: safeIds,
      })
      return { stdout: '', stderr: '' } as any
    })

    const text = String(result.stdout ?? '').trim()
    if (!text) {
      this.debug.log('runtime.windows.empty_stdout', { pids: safeIds, stderr: String(result.stderr ?? '').slice(0, 400) })
      return map
    }

    const parsed = this.parseJSON(text)
    if (!parsed) {
      this.debug.log('runtime.windows.parse_failed', { text_preview: text.slice(0, 300) })
      return map
    }

    const arr = Array.isArray(parsed) ? parsed : [parsed]
    for (const row of arr) {
      const pid = Number(row?.Id)
      if (!Number.isFinite(pid) || pid <= 0) {
        continue
      }
      map.set(pid, {
        pid,
        processName: typeof row?.ProcessName === 'string' ? row.ProcessName : undefined,
        memoryBytes: Number(row?.WorkingSet64 ?? 0) || 0,
        cpuSeconds: Number(row?.CPU ?? 0) || 0,
      })
    }

    return map
  }

  private async readPosixSnapshots (pids: number[]): Promise<Map<number, Snapshot>> {
    const map = new Map<number, Snapshot>()
    if (!pids.length) {
      return map
    }
    const safeIds = pids.filter(x => Number.isFinite(x) && x > 0).map(x => Math.floor(x))
    if (!safeIds.length) {
      return map
    }

    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,pcpu=,rss=,comm=', '-p', safeIds.join(',')], {
      maxBuffer: 1024 * 1024,
    }).catch(() => ({ stdout: '' } as any))

    const lines = String(stdout ?? '').split(/\r?\n/g).map(x => x.trim()).filter(Boolean)
    for (const line of lines) {
      const m = line.match(/^(\d+)\s+([0-9.]+)\s+(\d+)\s+(.+)$/)
      if (!m) {
        continue
      }
      const pid = Number(m[1])
      map.set(pid, {
        pid,
        cpuPercentDirect: Number(m[2]) || 0,
        memoryBytes: (Number(m[3]) || 0) * 1024,
        processName: m[4],
      })
    }
    return map
  }

  private async readSnapshots (pids: number[]): Promise<Map<number, Snapshot>> {
    if (process.platform === 'win32') {
      return this.readWindowsSnapshots(pids)
    }
    return this.readPosixSnapshots(pids)
  }

  private async tick (): Promise<void> {
    const tracked = [...this.trackedPids.values()].sort((a, b) => a - b)
    if (!tracked.length) {
      if (Object.keys(this.stats$.value).length) {
        this.stats$.next({})
      }
      this.sampleSystemStats()
      return
    }

    const now = Date.now()
    const snapshots = await this.readSnapshots(tracked)
    const next: Record<number, SessionRuntimeStat> = {}
    const cores = Math.max(1, os.cpus()?.length || 1)

    for (const pid of tracked) {
      const snap = snapshots.get(pid)
      if (!snap) {
        next[pid] = {
          pid,
          running: false,
          sampledAt: now,
          cpuPercent: 0,
          memoryBytes: 0,
        }
        this.prevCpu.delete(pid)
        continue
      }

      let cpuPercent = 0
      if (typeof snap.cpuPercentDirect === 'number') {
        cpuPercent = Math.max(0, snap.cpuPercentDirect)
      } else if (typeof snap.cpuSeconds === 'number') {
        const prev = this.prevCpu.get(pid)
        if (prev) {
          const dtSec = Math.max(0.001, (now - prev.ts) / 1000)
          const dcpu = Math.max(0, snap.cpuSeconds - prev.cpuSeconds)
          cpuPercent = (dcpu / dtSec / cores) * 100
        }
        this.prevCpu.set(pid, { ts: now, cpuSeconds: snap.cpuSeconds })
      }

      next[pid] = {
        pid,
        running: true,
        sampledAt: now,
        processName: snap.processName,
        memoryBytes: snap.memoryBytes ?? 0,
        cpuPercent: Math.max(0, cpuPercent),
      }
    }

    const sig = this.signature(next)
    if (sig !== this.lastSignature) {
      this.lastSignature = sig
      this.debug.log('runtime.stats.update', {
        tracked_count: tracked.length,
        running_count: Object.values(next).filter(x => x.running).length,
        stats: Object.values(next).map(x => ({
          pid: x.pid,
          running: x.running,
          cpu_percent: x.cpuPercent ?? 0,
          memory_mb: Math.round((x.memoryBytes ?? 0) / 1048576),
          process_name: x.processName ?? null,
        })),
      })
    }

    this.stats$.next(next)
    this.sampleSystemStats()
  }

  private sampleSystemStats (): void {
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedPct = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0
    const cores = Math.max(1, os.cpus()?.length || 1)

    // CPU load from os.cpus() idle/total delta.
    const cpus = os.cpus()
    let idle = 0
    let total = 0
    for (const c of cpus) {
      idle += c.times.idle
      total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle
    }
    let cpuPct = 0
    if (this.prevCpuTimes) {
      const dTotal = total - this.prevCpuTimes.total
      const dIdle = idle - this.prevCpuTimes.idle
      if (dTotal > 0) {
        cpuPct = ((dTotal - dIdle) / dTotal) * 100
      }
    }
    this.prevCpuTimes = { idle, total }

    this.system$.next({
      totalMemoryBytes: totalMem,
      freeMemoryBytes: freeMem,
      usedMemoryPercent: usedPct,
      cpuCores: cores,
      cpuLoadPercent: Math.max(0, cpuPct),
    })
  }

  getStat (pid?: number | null): SessionRuntimeStat | null {
    const p = Number(pid)
    if (!Number.isFinite(p) || p <= 0) {
      return null
    }
    return this.stats$.value[p] ?? null
  }

  async killByPid (pid: number): Promise<boolean> {
    const p = Number(pid)
    if (!Number.isFinite(p) || p <= 0) {
      return false
    }

    try {
      if (process.platform === 'win32') {
        await execFileAsync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${Math.floor(p)} -Force -ErrorAction Stop`], {
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        })
      } else {
        process.kill(Math.floor(p), 'SIGTERM')
      }
      this.debug.log('runtime.kill.ok', { pid: p })
      return true
    } catch (e: any) {
      this.debug.log('runtime.kill.failed', { pid: p, error: String(e?.message ?? e) })
      return false
    }
  }
}

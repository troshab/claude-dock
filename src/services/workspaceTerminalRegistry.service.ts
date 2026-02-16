import { Injectable } from '@angular/core'

@Injectable({ providedIn: 'root' })
export class WorkspaceTerminalRegistryService {
  private counts = new Map<string, number>()

  setWorkspaceCount (workspaceId: string, count: number): void {
    const id = String(workspaceId ?? '').trim()
    if (!id) {
      return
    }
    const n = Math.max(0, Math.floor(Number(count) || 0))
    if (n <= 0) {
      this.counts.delete(id)
      return
    }
    this.counts.set(id, n)
  }

  removeWorkspace (workspaceId: string): void {
    const id = String(workspaceId ?? '').trim()
    if (!id) {
      return
    }
    this.counts.delete(id)
  }

  getWorkspaceCount (workspaceId: string): number {
    const id = String(workspaceId ?? '').trim()
    if (!id) {
      return 0
    }
    return Math.max(0, Math.floor(Number(this.counts.get(id) ?? 0) || 0))
  }

  getTotalCount (): number {
    let total = 0
    for (const n of this.counts.values()) {
      total += Math.max(0, Math.floor(Number(n) || 0))
    }
    return total
  }
}


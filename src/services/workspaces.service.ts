import { Injectable, Injector } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, PlatformService, PromptModalComponent, SelectorOption, SelectorService } from 'tabby-core'

import { Workspace } from '../models'
import { newId, pathBase } from '../utils'

@Injectable({ providedIn: 'root' })
export class WorkspacesService {
  private config: ConfigService
  private platform: PlatformService
  private ngbModal: NgbModal
  private selector: SelectorService

  constructor (injector: Injector) {
    this.config = injector.get(ConfigService)
    this.platform = injector.get(PlatformService)
    this.ngbModal = injector.get(NgbModal)
    this.selector = injector.get(SelectorService)
    // ConfigService.store can be undefined very early during Tabby startup.
    // Don't assume it's ready in the constructor.
    this.ensureStoreShape()
  }

  private ensureStoreShape (): boolean {
    const store = (this.config as any).store
    if (!store) {
      return false
    }
    store.claudeCodeZit ??= {}
    store.claudeCodeZit.workspaces ??= []
    return true
  }

  list (): Workspace[] {
    if (!this.ensureStoreShape()) {
      return []
    }
    const ws = (this.config as any).store.claudeCodeZit.workspaces as Workspace[]
    return [...ws].sort((a, b) => {
      const la = a.lastActiveTs ?? 0
      const lb = b.lastActiveTs ?? 0
      if (la !== lb) return lb - la
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
    })
  }

  getById (id: string): Workspace | undefined {
    return this.list().find(w => w.id === id)
  }

  findByCwd (cwd: string): Workspace | undefined {
    if (!cwd) return undefined
    const normalized = cwd.replace(/\\/g, '/')
    return this.list().find(w => (w.cwd ?? '').replace(/\\/g, '/') === normalized)
  }

  async promptText (prompt: string, value: string): Promise<string | null> {
    const modal = this.ngbModal.open(PromptModalComponent)
    const inst = modal.componentInstance as PromptModalComponent
    inst.prompt = prompt
    inst.value = value
    inst.password = false
    inst.showRememberCheckbox = false
    const result = await modal.result.catch(() => null)
    return result?.value ?? null
  }

  async createInteractive (): Promise<Workspace | null> {
    const cwd = await this.platform.pickDirectory()
    if (!cwd) {
      return null
    }

    const suggestedTitle = pathBase(cwd) || cwd
    const title = await this.promptText('Workspace name', suggestedTitle)
    if (!title) {
      return null
    }

    return this.create({ cwd, title })
  }

  create (data: { cwd: string, title: string, profileId?: string }): Workspace {
    if (!this.ensureStoreShape()) {
      // Config isn't ready; create an ephemeral workspace object (won't persist).
      return {
        id: newId('ws'),
        cwd: data.cwd,
        title: data.title,
        profileId: data.profileId,
        sortOrder: 0,
      }
    }
    const wsList = (this.config as any).store.claudeCodeZit.workspaces as Workspace[]

    const existing = this.findByCwd(data.cwd)
    if (existing) {
      // Update title/profile if user created again.
      existing.title = data.title || existing.title
      if (data.profileId) {
        existing.profileId = data.profileId
      }
      this.config.save()
      return existing
    }

    const ws: Workspace = {
      id: newId('ws'),
      cwd: data.cwd,
      title: data.title,
      profileId: data.profileId,
      sortOrder: (wsList.length ? Math.max(...wsList.map(x => x.sortOrder ?? 0)) : 0) + 1,
    }
    wsList.push(ws)
    this.config.save()
    return ws
  }

  async renameInteractive (id: string): Promise<Workspace | null> {
    const ws = this.getById(id)
    if (!ws) {
      return null
    }
    const title = await this.promptText('Rename workspace', ws.title)
    if (!title) {
      return null
    }
    ws.title = title
    this.config.save()
    return ws
  }

  delete (id: string): void {
    if (!this.ensureStoreShape()) {
      return
    }
    const root = (this.config as any).store.claudeCodeZit
    const wsList = root.workspaces as Workspace[]
    root.workspaces = wsList.filter(w => w.id !== id)
    if (root.lastActiveWorkspaceId === id) {
      root.lastActiveWorkspaceId = null
    }
    this.config.save()
  }

  setLastActive (id: string | null): void {
    if (!this.ensureStoreShape()) {
      return
    }
    const root = (this.config as any).store.claudeCodeZit
    root.lastActiveWorkspaceId = id
    if (id) {
      const wsList = root.workspaces as Workspace[]
      const ws = wsList.find(w => w.id === id)
      if (ws) {
        ws.lastActiveTs = Date.now()
      }
    }
    this.config.save()
  }

  async openFromFolderPicker (): Promise<Workspace | null> {
    const cwd = await this.platform.pickDirectory()
    if (!cwd) {
      return null
    }
    const title = pathBase(cwd) || cwd
    const ws = this.create({ cwd, title })
    this.setLastActive(ws.id)
    return ws
  }

  updateWorkspace (id: string, patch: Partial<Workspace>): void {
    if (!this.ensureStoreShape()) return
    const wsList = (this.config as any).store.claudeCodeZit.workspaces as Workspace[]
    const ws = wsList.find(w => w.id === id)
    if (!ws) return
    Object.assign(ws, patch)
    this.config.save()
  }

  async pickWorkspace (title = 'Select workspace'): Promise<Workspace | null> {
    const workspaces = this.list()
    if (!workspaces.length) {
      return null
    }
    if (this.selector.active) {
      return null
    }
    const options: SelectorOption<Workspace>[] = workspaces.map(w => ({
      name: w.title,
      description: w.cwd,
      icon: 'fas fa-folder',
      callback: () => w,
    }))
    return await this.selector.show(title, options).catch(() => null)
  }
}

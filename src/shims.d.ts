/* Minimal type shims so we can build without bundling Tabby/Angular deps. */

declare module '@angular/core' {
  export const Component: any
  export const NgModule: any
  export const Injectable: any
  export const Input: any
  export const ViewChild: any
  export const HostBinding: any
  export const HostListener: any

  export class Injector {
    get(token: any, notFoundValue?: any): any
  }

  export class ViewContainerRef {
    insert(viewRef: any): any
    detach(index?: number): any
    indexOf(viewRef: any): number
    clear(): void
  }

  export class ElementRef<T = any> {
    nativeElement: T
  }

  export class ChangeDetectorRef {
    markForCheck(): void
    detectChanges(): void
  }
}

declare module '@angular/common' {
  export const CommonModule: any
}

declare module '@angular/forms' {
  export const FormsModule: any
}

declare module '@ng-bootstrap/ng-bootstrap' {
  export const NgbModule: any
  export class NgbModal {
    open(componentOrTemplateRef: any, options?: any): any
  }
  export class NgbActiveModal {
    close(result?: any): void
    dismiss(reason?: any): void
  }
}

declare module 'rxjs' {
  export class Observable<T = any> {
    subscribe(next?: (value: T) => any, error?: any, complete?: any): any
    pipe(...args: any[]): any
    toPromise(): Promise<T>
  }

  export class Subject<T = any> extends Observable<T> {
    next(value?: T): void
    complete(): void
  }

  export class BehaviorSubject<T = any> extends Subject<T> {
    value: T
    constructor(value: T)
  }
}

declare module 'tabby-core' {
  const TabbyCorePlugin: any
  export default TabbyCorePlugin

  export abstract class Logger {
    debug(...args: any[]): void
    info(...args: any[]): void
    warn(...args: any[]): void
    error(...args: any[]): void
    log(...args: any[]): void
  }

  export abstract class LogService {
    create(name: string): Logger
  }

  export class BaseTabComponent {
    [key: string]: any
    parent: any
    title: string
    customTitle: string
    icon: string | null
    color: string | null

    constructor(injector: any)

    setTitle(title: string): void
    insertIntoContainer(container: any): any
    removeFromContainer(): void
    destroy(skipDestroyedEvent?: boolean): void
    emitFocused(): void
    emitBlurred(): void
    emitVisibility(visible: boolean): void

    focused$: any
    blurred$: any
    visibility$: any
    titleChange$: any
    activity$: any
    progress$: any
    destroyed$: any
    recoveryStateChangedHint$: any
  }

  export class AppService {
    [key: string]: any
    tabs: any[]
    activeTab: any
    ready$: any
    openNewTabRaw(params: any): any
    openNewTab(params: any): any
    selectTab(tab: any): void
    addTabRaw(tab: any, index?: number | null): void
    closeTab(tab: any, checkCanClose?: boolean): Promise<void>
    emitTabsChanged(): void
  }

  export class TabsService {
    [key: string]: any
    create(params: any): any
  }

  export class ConfigService {
    [key: string]: any
    store: any
    changed$: any
    ready$: any
    save(): void
    requestRestart(): void
  }

  export abstract class ConfigProvider {
    defaults: any
    platformDefaults?: any
  }

  export class SelectorService {
    [key: string]: any
    active: boolean
    show(name: string, options: any[]): Promise<any>
  }

  export class PlatformService {
    [key: string]: any
    pickDirectory(): Promise<string | null>
    openPath(path: string): void
    showItemInFolder(path: string): void
    getConfigPath(): string | null
    popupContextMenu(menu: MenuItemOptions[], event?: MouseEvent): void
  }

  export interface MenuItemOptions {
    type?: string
    label?: string
    sublabel?: string
    enabled?: boolean
    checked?: boolean
    submenu?: MenuItemOptions[]
    click?: () => void
    commandLabel?: string
  }

  export abstract class TabContextMenuItemProvider {
    weight: number
    abstract getItems(tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]>
  }

  export class HostWindowService {
    [key: string]: any
    windowCloseRequest$: any
    windowFocused$: any
    setTitle(title?: string): void
    close(): void
  }

  export class ProfilesService {
    [key: string]: any
    getProfiles(options?: any): Promise<any[]>
    showProfileSelector(): Promise<any>
    newTabParametersForProfile(profile: any): Promise<any>
  }

  export class NotificationsService {
    [key: string]: any
    notice(text: string): void
    info(text: string, details?: string): void
    error(text: string, details?: string): void
  }

  export enum CommandLocation {
    LeftToolbar = 'left-toolbar',
    RightToolbar = 'right-toolbar',
    StartPage = 'start-page'
  }

  export class Command {
    id?: string
    label: string
    sublabel?: string
    locations?: CommandLocation[]
    run: () => Promise<void>
    icon?: string
    weight?: number
  }

  export interface CommandContext {
    tab?: any
  }

  export abstract class CommandProvider {
    abstract provide(context: CommandContext): Promise<Command[]>
  }

  export class PromptModalComponent {
    [key: string]: any
    value: string
    prompt?: string
    password: boolean
    remember: boolean
    showRememberCheckbox: boolean
  }

  export interface SelectorOption<T> {
    name: string
    group?: string
    description?: string
    icon?: string
    weight?: number
    callback: (query?: string) => any
    freeInputPattern?: string
    freeInputEquivalent?: string
  }
}

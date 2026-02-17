import { Injectable } from '@angular/core'
import { TabRecoveryProvider, RecoveryToken } from 'tabby-core'
import { WorkspaceTabComponent } from './components/workspaceTab.component'

@Injectable()
export class ClaudeDockRecoveryProvider extends TabRecoveryProvider {
  async applicableTo (recoveryToken: RecoveryToken): Promise<boolean> {
    return recoveryToken.type === 'app:claude-dock-workspace' || recoveryToken.type === 'app:claude-code-zit-workspace'
  }

  async recover (recoveryToken: RecoveryToken): Promise<any> {
    return {
      type: WorkspaceTabComponent,
      inputs: { workspaceId: recoveryToken.workspaceId },
    }
  }
}

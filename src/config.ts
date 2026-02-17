import { ConfigProvider } from 'tabby-core'

export class ClaudeDockConfigProvider extends ConfigProvider {
  defaults = {
    claudeDock: {
      dashboardPinned: true,
      viewMode: 'flat',
      sortPreset: 'status',
      groupSortPreset: 'waiting',
      sessionTTLMinutes: 30,
      notifyOnWaiting: false,
      workspaces: [],
      savedTerminals: {},
      lastActiveWorkspaceId: null,
      defaultDockerImage: 'ghcr.io/troshab/claude-dock:1.0.0',
      debugLogging: false,
    },
  }
}


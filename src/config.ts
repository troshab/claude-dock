import { ConfigProvider } from 'tabby-core'

export class ClaudeCodeZitConfigProvider extends ConfigProvider {
  defaults = {
    claudeCodeZit: {
      dashboardPinned: true,
      viewMode: 'flat',
      sortPreset: 'status',
      groupSortPreset: 'waiting',
      sessionTTLMinutes: 30,
      notifyOnWaiting: false,
      workspaces: [],
      savedTerminals: {},
      lastActiveWorkspaceId: null,
    },
  }
}


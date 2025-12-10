import {
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  EventEmitter,
  Event,
  workspace,
  window,
  commands,
  ThemeIcon,
  ConfigurationTarget
} from "vscode"
import { RemoteConfig } from "../config"
import { connectedRoots, formatKey } from "../config"
import { ConnectionEditor } from "./connectionEditor"

interface ConnectionItem {
  connection: RemoteConfig
  target: ConfigurationTarget
}

export class ConnectionTreeItem extends TreeItem {
  constructor(
    public readonly connectionItem: ConnectionItem,
    public readonly collapsibleState: TreeItemCollapsibleState
  ) {
    super(connectionItem.connection.name, collapsibleState)
    
    const isConnected = connectedRoots().has(formatKey(connectionItem.connection.name))
    
    this.tooltip = this.getTooltip()
    this.description = this.getDescription()
    this.iconPath = isConnected 
      ? new ThemeIcon("vm-active", undefined) 
      : new ThemeIcon("vm-outline", undefined)
    this.contextValue = this.getContextValue()
  }

  private getTooltip(): string {
    const conn = this.connectionItem.connection
    const target = this.connectionItem.target === ConfigurationTarget.Global ? "User" : "Workspace"
    return `${conn.name}
URL: ${conn.url}
User: ${conn.username}
Client: ${conn.client}
Language: ${conn.language}
Scope: ${target}`
  }

  private getDescription(): string {
    const conn = this.connectionItem.connection
    return `${conn.url}`
  }

  private getContextValue(): string {
    const target = this.connectionItem.target === ConfigurationTarget.Global ? "global" : "workspace"
    const isConnected = connectedRoots().has(formatKey(this.connectionItem.connection.name))
    return `connection-${target}${isConnected ? "-connected" : ""}`
  }
}

export class ConnectionsProvider implements TreeDataProvider<ConnectionTreeItem> {
  private _onDidChangeTreeData = new EventEmitter<ConnectionTreeItem | undefined | void>()
  readonly onDidChangeTreeData: Event<ConnectionTreeItem | undefined | void> = this._onDidChangeTreeData.event
  private static _instance: ConnectionsProvider

  private constructor() {
    // Listen to configuration changes to refresh the view
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("abapfs.remote")) {
        this.refresh()
      }
    })
  }

  public static get(): ConnectionsProvider {
    if (!ConnectionsProvider._instance) {
      ConnectionsProvider._instance = new ConnectionsProvider()
    }
    return ConnectionsProvider._instance
  }

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(element: ConnectionTreeItem): TreeItem {
    return element
  }

  async getChildren(element?: ConnectionTreeItem): Promise<ConnectionTreeItem[]> {
    if (element) {
      return []
    }

    const connections = this.getAllConnections()
    return connections.map(item => 
      new ConnectionTreeItem(item, TreeItemCollapsibleState.None)
    )
  }

  private getAllConnections(): ConnectionItem[] {
    const config = workspace.getConfiguration("abapfs")
    const remotes = config.inspect("remote")
    const connections: ConnectionItem[] = []

    // Get global (user) connections
    if (remotes?.globalValue) {
      const globalRemotes = remotes.globalValue as Record<string, RemoteConfig>
      for (const [name, remote] of Object.entries(globalRemotes)) {
        connections.push({
          connection: { ...remote, name },
          target: ConfigurationTarget.Global
        })
      }
    }

    // Get workspace connections
    if (remotes?.workspaceValue) {
      const workspaceRemotes = remotes.workspaceValue as Record<string, RemoteConfig>
      for (const [name, remote] of Object.entries(workspaceRemotes)) {
        connections.push({
          connection: { ...remote, name },
          target: ConfigurationTarget.Workspace
        })
      }
    }

    // Sort by name
    connections.sort((a, b) => a.connection.name.localeCompare(b.connection.name))

    return connections
  }

  public async deleteConnection(item: ConnectionTreeItem): Promise<void> {
    const { connection, target } = item.connectionItem
    
    const confirm = await window.showWarningMessage(
      `Are you sure you want to delete connection "${connection.name}"?`,
      { modal: true },
      "Delete"
    )

    if (confirm !== "Delete") return

    const config = workspace.getConfiguration("abapfs")
    const remotes = config.get("remote") as Record<string, RemoteConfig>
    
    // Get the appropriate target remotes
    const targetRemotes = target === ConfigurationTarget.Global
      ? (config.inspect("remote")?.globalValue as Record<string, RemoteConfig>) || {}
      : (config.inspect("remote")?.workspaceValue as Record<string, RemoteConfig>) || {}

    // Remove the connection
    const updatedRemotes = { ...targetRemotes }
    delete updatedRemotes[connection.name]

    await config.update("remote", updatedRemotes, target)
    
    window.showInformationMessage(`Connection "${connection.name}" deleted`)
    this.refresh()
  }

  public async editConnection(item: ConnectionTreeItem): Promise<void> {
    const { connection, target } = item.connectionItem
    
    ConnectionEditor.show(connection, target, () => {
      this.refresh()
    })
  }

  public async connectToSystem(item: ConnectionTreeItem): Promise<void> {
    const { connection } = item.connectionItem
    // Use the existing connect command with the connection ID
    await commands.executeCommand("abapfs.connect", { connection: connection.name })
  }
}

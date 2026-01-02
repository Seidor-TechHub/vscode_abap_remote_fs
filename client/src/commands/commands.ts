import { PACKAGE, AdtObjectCreator } from "../adt/operations/AdtObjectCreator"
import { NewObjectOptions } from "abap-adt-api"
import {
  workspace,
  Uri,
  window,
  commands,
  ProgressLocation,
  Range,
  FileChangeType,
  extensions,
  ViewColumn,
  env,
  WebviewPanel,
  QuickPickItem
} from "vscode"
import { pickAdtRoot, RemoteManager } from "../config"
import { caughtToString, inputBox, lineRange, log, rangeVscToApi, splitAdtUri, setupWebGuiProxy } from "../lib"
import { FavouritesProvider, FavItem } from "../views/favourites"
import { ConnectionsProvider, ConnectionTreeItem } from "../views/connections"
import { findEditor, vsCodeUri } from "../langClient"
import { showHideActivate } from "../listeners"
import { UnitTestRunner } from "../adt/operations/UnitTestRunner"
import { selectTransport } from "../adt/AdtTransports"
import { showInGuiCb, executeInGui, runInSapGui, SapGui, getSapGuiCommand, SapGuiCommand } from "../adt/sapgui/sapgui"
import { runTCode } from "./tcode"
import { WebGuiCustomEditorProvider } from "../editors/webGuiEditor"
import { storeTokens } from "../oauth"
import { showAbapDoc } from "../views/help"
import { showQuery } from "../views/query/query"
import {
  ADTSCHEME,
  getClient,
  getRoot,
  uriRoot,
  getOrCreateRoot
} from "../adt/conections"
import { isAbapFolder, isAbapFile, isAbapStat } from "abapfs"
import { AdtObjectActivator } from "../adt/operations/AdtObjectActivator"
import {
  AdtObjectFinder,
  createUri,
  findAbapObject,
  uriAbapFile
} from "../adt/operations/AdtObjectFinder"
import { isAbapClassInclude } from "abapobject"
import { AbapObject } from "abapobject"
import { IncludeProvider } from "../adt/includes" // resolve dependencies
import { command, AbapFsCommands } from "."
import { createConnection } from "./connectionwizard"
import { types } from "util"
import { atcProvider } from "../views/abaptestcockpit"
import { context } from "../extension"
import { FsProvider } from "../fs/FsProvider"

export function currentUri() {
  if (window.activeTextEditor && window.activeTextEditor.document.uri.scheme === ADTSCHEME) {
    return window.activeTextEditor.document.uri
  }
  const tab = window.tabGroups.activeTabGroup.activeTab
  if (tab && (tab.input as any)?.uri?.scheme === ADTSCHEME) {
    return (tab.input as any).uri as Uri
  }
}
export function currentAbapFile() {
  const uri = currentUri()
  return uriAbapFile(uri)
}

export function currentEditState() {
  const uri = currentUri()
  if (!uri) return
  const line = window.activeTextEditor?.selection.active.line
  return { uri, line }
}

export function openObject(connId: string, uri: string) {
  return window.withProgress(
    { location: ProgressLocation.Window, title: "Opening..." },
    async () => {
      const root = getRoot(connId)
      const { file, path } = (await root.findByAdtUri(uri, true)) || {}
      if (!file || !path) throw new Error("Object not found in workspace")
      if (isAbapFolder(file) && file.object.type === PACKAGE) {
        await commands.executeCommand(
          "revealInExplorer",
          createUri(connId, path)
        )
        return
      } else if (isAbapFile(file))
        await workspace
          .openTextDocument(createUri(connId, path))
          .then(window.showTextDocument)
      return { file, path }
    }
  )
}
interface ShowObjectArgument {
  connId: string,
  uri: string
}

/**
 * Helper function to get the execute command for an ABAP object
 */
function getExecuteCommand(object: AbapObject): SapGuiCommand {
  const { type, name } = object
  let transaction = ""
  let dynprofield = ""
  let okcode = ""
  switch (type) {
    case "PROG/P":
      transaction = "SE38"
      dynprofield = "RS38M-PROGRAMM"
      okcode = "STRT"
      break
    case "FUGR/FF":
      transaction = "SE37"
      dynprofield = "RS38L-NAME"
      okcode = "WB_EXEC"
      break
    case "CLAS/OC":
      transaction = "SE24"
      dynprofield = "SEOCLASS-CLSNAME"
      okcode = "WB_EXEC"
      break
    default:
      return showInGuiCb(object.sapGuiUri)()
  }
  return {
    type: "Transaction",
    command: `*${transaction}`,
    parameters: [
      { name: dynprofield, value: name },
      { name: "DYNP_OKCODE", value: okcode }
    ]
  }
}

export class AdtCommands {
  @command(AbapFsCommands.extractMethod)
  private static async extractMethod(url: string, range: Range) {
    const uri = Uri.parse(url)
    const client = getClient(uri.authority)
    const root = getRoot(uri.authority)
    const file = await root.getNodeAsync(uri.path)
    if (isAbapFile(file)) {
      const o = file.object
      const proposal = await client.extractMethodEvaluate(o.path, rangeVscToApi(range))
      const methodName = await window.showInputBox({ prompt: "Method name" })
      if (!methodName) return
      const transport = await selectTransport(o.path, "", client)
      if (transport.cancelled) return
      proposal.genericRefactoring.transport = transport.transport
      proposal.name = methodName
      const preview = await client.extractMethodPreview(proposal)
      await client.extractMethodExecute(preview)
      FsProvider.get().notifyChanges([{ type: FileChangeType.Changed, uri }])
    }

  }
  @command(AbapFsCommands.showDocumentation)
  private static async showAbapDoc() {
    return showAbapDoc()
  }

  @command(AbapFsCommands.selectDB)
  private static async selectDB(table?: string) {
    return showQuery(table)
  }

  @command(AbapFsCommands.changeInclude)
  private static async changeMain(uri: Uri) {
    return IncludeProvider.get().switchInclude(uri)
  }

  @command(AbapFsCommands.createConnection)
  private static createConnectionCommand() {
    return createConnection()
  }

  @command(AbapFsCommands.connect)
  private static async connectAdtServer(selector: any) {
    let name = ""
    try {
      const connectionID = selector && selector.connection
      const manager = RemoteManager.get()
      const { remote, userCancel } = await manager.selectConnection(
        connectionID
      )
      if (!remote)
        if (!userCancel)
          throw Error("No remote configuration available in settings")
        else return
      name = remote.name

      log(`Connecting to server ${remote.name}`)
      // this might involve asking for a password...
      await getOrCreateRoot(remote.name) // if connection raises an exception don't mount any folder

      await storeTokens()

      workspace.updateWorkspaceFolders(0, 0, {
        uri: Uri.parse("adt://" + remote.name),
        name: remote.name + "(ABAP)"
      })
      context.subscriptions.push(UnitTestRunner.get(connectionID).controller)


      log(`Connected to server ${remote.name}`)
    } catch (e) {
      const body = typeof e === "object" && (e as any)?.response?.body
      if (body) log(body)
      const isMissing = (e: any) =>
        !!`${e}`.match("name.*org.freedesktop.secrets")
      const message = isMissing(e)
        ? `Password storage not supported. Please install gnome-keyring or add a password to the connection`
        : `Failed to connect to ${name}:${caughtToString(e)}`
      return window.showErrorMessage(message)
    }
  }

  @command(AbapFsCommands.activate)
  private static async activateCurrent(selector: Uri) {
    try {
      const uri = selector || currentUri()
      const activator = AdtObjectActivator.get(uri.authority)
      const editor = findEditor(uri.toString())
      await window.withProgress(
        { location: ProgressLocation.Window, title: "Activating..." },
        async () => {
          const obj = await findAbapObject(uri)
          // if editor is dirty, save before activate
          if (editor && editor.document.isDirty) {
            const saved = await editor.document.save()
            if (!saved) return
          }
          await activator.activate(obj, uri)
          if (editor === window.activeTextEditor) {
            await workspace.fs.stat(uri)
            await showHideActivate(editor)
          }
        }
      )
    } catch (e) {
      return window.showErrorMessage(caughtToString(e))
    }
  }

  @command(AbapFsCommands.activateMultiple)
  private static async activateMultiple() {
    try {
      const uri = currentUri()
      if (!uri) return
      const connId = uri.authority
      const client = getClient(connId)
      const activator = AdtObjectActivator.get(connId)

      const inactiveResults = (await client.inactiveObjects()).filter(r => r.object)
      if (inactiveResults.length === 0) {
        window.showInformationMessage("No inactive objects found")
        return
      }

      const items: QuickPickItem[] = inactiveResults.map(r => ({
        label: `${r.object!["adtcore:name"]} (${r.object!["adtcore:type"]})`,
        detail: r.object!["adtcore:type"],
        picked: false
      }))

      const selected = await window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: "Select objects to activate"
      })

      if (!selected || selected.length === 0) return

      await window.withProgress(
        { location: ProgressLocation.Window, title: "Activating..." },
        async () => {
          // Create finder once, reuse for all objects (optimization)
          const finder = new AdtObjectFinder(connId)

          // Process all selected items in parallel for better performance
          const resolvedItems = await Promise.all(
            selected.map(async item => {
              const index = items.indexOf(item)
              const result = inactiveResults[index]
              if (!result?.object) return null

              const obj = result.object
              try {
                // Get both object and URI efficiently using vscodeUriWithFile
                const { uri: vscUri, file } = await finder.vscodeUriWithFile(obj["adtcore:uri"])
                if (!file || !isAbapStat(file)) return null

                return {
                  inactive: obj,
                  object: file.object,
                  uri: Uri.parse(vscUri)
                }
              } catch {
                return null
              }
            })
          )

          // Filter out nulls and extract arrays
          const validItems = resolvedItems.filter((item): item is NonNullable<typeof item> => item !== null)

          await activator.activateMultiple(
            validItems.map(i => i.inactive),
            validItems.map(i => i.object),
            validItems.map(i => i.uri)
          )
        }
      )
      window.showInformationMessage(`Activated ${selected.length} objects`)
    } catch (e) {
      return window.showErrorMessage(caughtToString(e))
    }
  }
  @command(AbapFsCommands.pickAdtRootConn)
  private static async pickRoot() {
    const uri = currentUri()
    const fsRoot = await pickAdtRoot(uri)
    if (!fsRoot) return
    return fsRoot.uri.authority
  }

  @command(AbapFsCommands.runClass)
  private static async runClass() {
    try {
      const uri = currentUri()
      if (!uri) return
      const client = getClient(uri.authority)
      const fsRoot = await pickAdtRoot(uri)
      if (!fsRoot) return
      const file = uriRoot(fsRoot.uri).getNode(uri.path)
      const clas = isAbapFile(file) && isAbapClassInclude(file.object) && file.object.parent
      if (clas) {
        const text = await client.runClass(clas.name)
        log(text)
      }
    } catch (error) {
      log(caughtToString(error))
    }

  }

  @command(AbapFsCommands.search)
  private static async searchAdtObject(uri: Uri | undefined) {
    // find the adt relevant namespace roots, and let the user pick one if needed
    const adtRoot = await pickAdtRoot(uri)
    if (!adtRoot) return
    try {
      const connId = adtRoot.uri.authority
      const object = await new AdtObjectFinder(connId).findObject()
      if (!object) return // user cancelled
      // found, show progressbar as opening might take a while
      await openObject(connId, object.uri)
    } catch (e) {
      return window.showErrorMessage(caughtToString(e))
    }
  }

  @command(AbapFsCommands.searchObjectDirect)
  private static async searchAdtObjectDirect(objectName: string, uri?: Uri) {
    // find the adt relevant namespace roots, and let the user pick one if needed
    const adtRoot = await pickAdtRoot(uri)
    if (!adtRoot) return
    try {
      const connId = adtRoot.uri.authority
      const finder = new AdtObjectFinder(connId)
      const object = await finder.findObjectByName(objectName)
      if (!object) {
        window.showInformationMessage(`No object found with name ${objectName}`)
        return
      }
      // found, show progressbar as opening might take a while
      await openObject(connId, object.uri)
    } catch (e) {
      return window.showErrorMessage(caughtToString(e))
    }
  }

  @command(AbapFsCommands.create)
  private static async createAdtObject(uri: Uri | undefined) {
    try {
      log("createAdtObject called")
      // find the adt relevant namespace roots, and let the user pick one if needed
      const fsRoot = await pickAdtRoot(uri)
      const connId = fsRoot?.uri.authority
      if (!connId) return
      const obj = await new AdtObjectCreator(connId).createObject(uri)
      if (!obj) return // user aborted
      log(`Created object ${obj.type} ${obj.name}`)
      await obj.loadStructure()

      if (obj.type === PACKAGE) {
        commands.executeCommand("workbench.files.action.refreshFilesExplorer")
        return // Packages can't be opened perhaps could reveal it?
      }
      const nodePath = await openObject(connId, obj.path)
      if (nodePath) {
        new AdtObjectFinder(connId).displayNode(nodePath)
        try {
          await commands.executeCommand(
            "workbench.files.action.refreshFilesExplorer"
          )
          log("workspace refreshed")
        } catch (e) {
          log("error refreshing workspace")
        }
      }
    } catch (e) {
      const stack = types.isNativeError(e) ? e.stack || "" : ""
      log("Exception in createAdtObject:", stack)
      return window.showErrorMessage(caughtToString(e))
    }
  }

  @command(AbapFsCommands.createDirectly)
  private static async createAdtObjectDirectly(connId: string, options: NewObjectOptions | string, devclass: string, transport?: string) {
    try {
      log("createAdtObjectDirectly called", JSON.stringify({ connId, options, devclass, transport }))
      if (typeof options === "string") {
        try {
          options = JSON.parse(options)
        } catch (e) {
          return window.showErrorMessage("Invalid options argument: " + e)
        }
      }
      if (!connId) {
        const fsRoot = await pickAdtRoot(undefined)
        connId = fsRoot?.uri.authority || ""
      }
      if (!connId) return

      const obj = await new AdtObjectCreator(connId).createObjectDirectly(options as NewObjectOptions, devclass, transport)
      if (!obj) return // user aborted
      log(`Created object ${obj.type} ${obj.name}`)
      await obj.loadStructure()

      if (obj.type === PACKAGE) {
        commands.executeCommand("workbench.files.action.refreshFilesExplorer")
        return // Packages can't be opened perhaps could reveal it?
      }
      const nodePath = await openObject(connId, obj.path)
      if (nodePath) {
        new AdtObjectFinder(connId).displayNode(nodePath)
        try {
          await commands.executeCommand(
            "workbench.files.action.refreshFilesExplorer"
          )
          log("workspace refreshed")
        } catch (e) {
          log("error refreshing workspace")
        }
      }
    } catch (e) {
      const stack = types.isNativeError(e) ? e.stack || "" : ""
      log("Exception in createAdtObjectDirectly:", stack)
      return window.showErrorMessage(caughtToString(e))
    }
  }

  @command(AbapFsCommands.showObject)
  private static async showObject(arg: ShowObjectArgument) {
    const p = splitAdtUri(arg.uri)
    const path = await vsCodeUri(arg.connId, arg.uri, true, true)
    const uri = Uri.parse(path)
    const doc = await workspace.openTextDocument(uri)
    const selection = p.start?.line ? lineRange(p.start?.line + 1) : undefined
    window.showTextDocument(doc, { selection })
  }
  @command(AbapFsCommands.runInGui)
  private static async executeAbap() {
    try {
      log("Execute ABAP")
      const uri = currentUri()
      if (!uri) return
      const fsRoot = await pickAdtRoot(uri)
      if (!fsRoot) return
      const file = uriRoot(fsRoot.uri).getNode(uri.path)
      if (!isAbapStat(file) || !file.object.sapGuiUri) return
      await executeInGui(fsRoot.uri.authority, file.object)

    } catch (e) {
      return window.showErrorMessage(caughtToString(e))
    }
  }

  @command(AbapFsCommands.runInWebGui)
  private static async executeAbapInWebGui() {
    try {
      log("Execute ABAP in WebGUI")
      const uri = currentUri()
      if (!uri) return
      const fsRoot = await pickAdtRoot(uri)
      if (!fsRoot) return
      const file = uriRoot(fsRoot.uri).getNode(uri.path)
      if (!isAbapStat(file) || !file.object.sapGuiUri) return
      
      let object = file.object
      const connId = fsRoot.uri.authority

      // Handle class includes - use parent class
      if (isAbapClassInclude(object) && object.parent) {
        object = object.parent
      }

      const config = await RemoteManager.get().byIdAsync(connId)
      if (!config) return

      const sapGui = SapGui.create(config)
      const cmd = getExecuteCommand(object)
      const url = sapGui.getWebGuiUrl(config, cmd)
      if (!url) return

      // Use shared WebGUI proxy utility for HTTPS with self-signed certificates
      const { proxyUrl } = await setupWebGuiProxy(config, url, connId)

      // Create embedded webview panel
      const panel = window.createWebviewPanel(
        'abapExecuteWebGui',
        `Execute: ${object.name}`,
        ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      )

      panel.webview.html = WebGuiCustomEditorProvider.generateWebGuiHtml(url, proxyUrl)
    } catch (e) {
      return window.showErrorMessage(caughtToString(e))
    }
  }

  @command(AbapFsCommands.execute)
  private static async openInGuiAbap() {
    try {
      log("Open ABAP in GUI")
      const uri = currentUri()
      if (!uri) return
      const fsRoot = await pickAdtRoot(uri)
      if (!fsRoot) return
      const file = uriRoot(fsRoot.uri).getNode(uri.path)
      if (!isAbapStat(file) || !file.object.sapGuiUri) return
      await runInSapGui(fsRoot.uri.authority, showInGuiCb(file.object.sapGuiUri))
    } catch (e) {
      return window.showErrorMessage(caughtToString(e))
    }
  }

  @command(AbapFsCommands.addfavourite)
  private static addFavourite(uri: Uri | undefined) {
    // find the adt relevant namespace roots, and let the user pick one if needed
    if (uri) FavouritesProvider.get().addFavourite(uri)
  }

  @command(AbapFsCommands.deletefavourite)
  private static deleteFavourite(node: FavItem) {
    FavouritesProvider.get().deleteFavourite(node)
  }

  @command(AbapFsCommands.tableContents)
  private static showTableContents() {
    const file = currentAbapFile()
    if (!file) {
      window.showInformationMessage("Unable to determine the table to display")
      return
    }
    commands.executeCommand(AbapFsCommands.selectDB, file.object.name)
  }

  @command(AbapFsCommands.unittest)
  private static async runAbapUnit() {
    try {
      log("Execute ABAP Unit tests")
      const uri = currentUri()
      if (!uri) return

      await window.withProgress(
        { location: ProgressLocation.Window, title: "Running ABAP UNIT" },
        () => UnitTestRunner.get(uri.authority).addResults(uri)
      )
    } catch (e) {
      return window.showErrorMessage(caughtToString(e))
    }
  }

  @command(AbapFsCommands.atcChecks)
  private static async runAtc() {
    try {
      const state = await currentEditState()
      if (!state) return

      await window.withProgress(
        { location: ProgressLocation.Window, title: "Running ABAP Test cockpit" },
        () => atcProvider.runInspector(state.uri)
      )
    } catch (e) {
      return window.showErrorMessage(caughtToString(e))
    }
  }

  @command(AbapFsCommands.createtestinclude)
  private static createTestInclude(uri?: Uri) {
    if (uri) {
      if (uri.scheme !== ADTSCHEME) return
      return this.createTI(uri)
    }
    const cur = currentEditState()
    if (!cur) return
    return this.createTI(cur.uri)
  }

  @command(AbapFsCommands.clearPassword)
  public static async clearPasswordCmd(connectionId?: string) {
    return RemoteManager.get().clearPasswordCmd(connectionId)
  }

  private static async createTI(uri: Uri) {
    const obj = await findAbapObject(uri)
    // only makes sense for classes
    if (!isAbapClassInclude(obj)) return
    if (!obj.parent) return
    if (obj.parent.structure) await obj.loadStructure()
    if (obj.parent.findInclude("testclasses"))
      return window.showInformationMessage("Test include already exists")

    const m = uriRoot(uri).lockManager
    const lock = await m.requestLock(uri.path)
    const lockId = lock.status === "locked" && lock.LOCK_HANDLE
    if (!lockId) {
      throw new Error(`Can't acquire a lock for ${obj.name}`)
    }
    try {
      let created
      const client = getClient(uri.authority)

      const transport = await selectTransport(
        obj.contentsPath(),
        "",
        client,
        true
      )
      if (transport.cancelled) return
      const parentName = obj.parent.name
      await client.createTestInclude(parentName, lockId, transport.transport)
      created = true

      // TODO locking logic
      // If I created the lock I remove it. Possible race condition here...
      if (lock) await m.requestUnlock(uri.path)
      if (created) {
        if (window.activeTextEditor)
          showHideActivate(window.activeTextEditor, true)
        commands.executeCommand("workbench.files.action.refreshFilesExplorer")
      }
    } catch (e) {
      if (lock) await m.requestUnlock(uri.path)
      log(caughtToString(e))
      window.showErrorMessage(`Error creating class include`)
    }
  }

  @command(AbapFsCommands.toggleEditor)
  private static async toggleEditor(uri?: Uri) {
    if (!uri) {
      uri = window.activeTextEditor?.document.uri
      if (!uri) {
        const tab = window.tabGroups.activeTabGroup.activeTab
        if (tab && (tab.input as any)?.uri) {
          uri = (tab.input as any).uri
        }
      }
    }
    if (!uri) return

    // If we are in a text editor, we want to open the WebGUI (custom editor)
    if (window.activeTextEditor && window.activeTextEditor.document.uri.toString() === uri.toString()) {
      const path = uri.path.toLowerCase()
      const viewType = path.match(/\.(clas|prog|fugr|intf|type)\.abap$/) ? 'abapfs.webgui_secondary' : 'abapfs.webgui'
      await commands.executeCommand('vscode.openWith', uri, viewType)
    } else {
      // If we are in the custom editor (WebGUI), we want to open the default text editor
      await commands.executeCommand('vscode.openWith', uri, 'default')
    }
  }

  @command(AbapFsCommands.openDynpro)
  private static async openDynpro(connId: string, programName: string, screenNumber: string) {
    try {
      const config = RemoteManager.get().byId(connId)
      if (!config) return
      const sapGui = SapGui.create(config)
      const cmd: SapGuiCommand = {
        type: "Transaction",
        command: "*SE51",
        parameters: [
          { name: "RS38M-PROGRAMM", value: programName },
          { name: "RS38M-DYNNR", value: screenNumber }
        ]
      }
      const url = sapGui.getWebGuiUrl(config, cmd)
      if (!url) return

      // Use shared WebGUI proxy utility
      const { proxyUrl } = await setupWebGuiProxy(config, url, connId)

      const panel = window.createWebviewPanel(
        'abapDynpro',
        `Dynpro ${screenNumber} - ${programName}`,
        ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      )
      panel.webview.html = WebGuiCustomEditorProvider.generateWebGuiHtml(url, proxyUrl, false)
    } catch (e) {
      return window.showErrorMessage(caughtToString(e))
    }
  }

  @command(AbapFsCommands.refreshConnections)
  private static refreshConnections() {
    ConnectionsProvider.get().refresh()
  }

  @command(AbapFsCommands.deleteConnection)
  private static async deleteConnection(item: ConnectionTreeItem) {
    if (item) {
      await ConnectionsProvider.get().deleteConnection(item)
    }
  }

  @command(AbapFsCommands.editConnection)
  private static async editConnection(item: ConnectionTreeItem) {
    if (item) {
      await ConnectionsProvider.get().editConnection(item)
    }
  }

  @command(AbapFsCommands.connectToConnection)
  private static async connectToConnection(item: ConnectionTreeItem) {
    if (item) {
      await ConnectionsProvider.get().connectToSystem(item)
    }
  }

  @command(AbapFsCommands.runTCode)
  private static async runTCode() {
    return runTCode()
  }
}

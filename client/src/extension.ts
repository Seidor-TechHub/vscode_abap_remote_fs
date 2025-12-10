import { TransportsProvider } from "./views/transports"
import { FavouritesProvider } from "./views/favourites"
import { ConnectionsProvider } from "./views/connections"
import { atcProvider, registerSCIDecorator } from "./views/abaptestcockpit"
import { FsProvider } from "./fs/FsProvider"
import {
  window,
  workspace,
  ExtensionContext,
  languages
} from "vscode"
import {
  activeTextEditorChangedListener,
  documentChangedListener,
  documentClosedListener,
  documentWillSave,
  restoreLocks
} from "./listeners"
import { PasswordVault, log } from "./lib"
import { LanguageCommands } from "./langClient"
import { registerRevisionModel, AbapRevisionLens } from "./scm/abaprevisions"
import { ClassHierarchyLensProvider } from "./adt/classhierarchy"
import { abapGitProvider } from "./views/abapgit"
import { loadTokens, clearTokens } from "./oauth"
import { registerAbapGit } from "./scm/abapGit"
import { AbapFsApi, api } from "./api"
import { ADTSCHEME, disconnect, hasLocks } from "./adt/conections"
import { MessagesProvider } from "./editors/messages"
import { IncludeProvider } from "./adt/includes"
import { registerCommands } from "./commands/register"
import { HttpProvider } from "./editors/httpprovider"
import { WebGuiCustomEditorProvider } from "./editors/webGuiEditor"
import { dumpProvider } from "./views/dumps/dumps"
import { registerAbapDebugger, ExternalBreakpointManager } from "./adt/debugger"
import { ATCDocumentation } from "./views/abaptestcockpit/documentation"
import { TableViewProvider } from "./adt/debugger/tableView"
import { VariableTracker } from "./adt/debugger/variableTracker"
import { tracesProvider } from "./views/traces"
import { setContext } from "./context"
import { objectPropertiesProvider } from "./views/objectProperties"
import { AbapObjectSearchProvider } from "./views/abapObjectSearch"
import { getStatusBar } from "./status"
import express from 'express'
import * as cheerio from 'cheerio'
import { stopWebGuiProxy } from "./webguiProxy"

export let context: ExtensionContext

export async function activate(ctx: ExtensionContext): Promise<AbapFsApi> {
  context = ctx
  const startTime = new Date().getTime()
  log("activating ABAPfs...")
  new PasswordVault(ctx)
  loadTokens()
  clearTokens()
  const sub = context.subscriptions

  // Start proxy server
  const app = express()
  let server: any
  app.use('/proxy', (req, res) => {
    const targetUrl = req.query.url as string
    if (!targetUrl) return res.status(400).send('No url')
    try {
      const url = new URL(targetUrl)
      const https = require('https')
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: req.method,
        headers: { ...req.headers, host: url.host },
        rejectUnauthorized: false
      }
      delete (options.headers as any)['accept-encoding'] // to avoid gzip issues
      const proxyReq = https.request(options, (proxyRes: any) => {
        const contentType = proxyRes.headers['content-type'] || ''
        if (contentType.includes('text/html')) {
          let body = ''
          proxyRes.setEncoding('utf8')
          proxyRes.on('data', (chunk: any) => body += chunk)
          proxyRes.on('end', () => {
            const $ = cheerio.load(body)
            $('head').prepend(`<base href="${url.protocol}//${url.host}/">`)
            // replace absolute urls starting with /
            $('a[href]').each((i, el) => {
              const href = $(el).attr('href')
              if (href && href.startsWith('/') && !href.startsWith('//')) {
                $(el).attr('href', `/proxy?url=${url.protocol}//${url.host}${href}`)
              }
            })
              ;['img[src]', 'script[src]', 'link[href]'].forEach(selector => {
                $(selector).each((i, el) => {
                  const attr = selector.includes('href') ? 'href' : 'src'
                  const val = $(el).attr(attr)
                  if (val && val.startsWith('/') && !val.startsWith('//')) {
                    $(el).attr(attr, `/proxy?url=${url.protocol}//${url.host}${val}`)
                  }
                })
              })
            res.set(proxyRes.headers)
            res.send($.html())
          })
        } else {
          res.set(proxyRes.headers)
          proxyRes.pipe(res)
        }
      })
      proxyReq.on('error', (e: any) => {
        res.status(500).send('Proxy error: ' + e.message)
      })
      req.pipe(proxyReq)
    } catch (e) {
      res.status(400).send('Invalid url')
    }
  })
  server = app.listen(0, 'localhost', () => {
    const port = server.address().port
    context.globalState.update('proxyPort', port)
    log(`Proxy server listening on port ${port}`)
  })
  sub.push({ dispose: () => server.close() })

  // register the filesystem type
  sub.push(
    workspace.registerFileSystemProvider(ADTSCHEME, FsProvider.get(), {
      isCaseSensitive: true
    })
  )

  // change document listener, for locking (and possibly validation in future)
  sub.push(workspace.onDidChangeTextDocument(documentChangedListener))
  sub.push(workspace.onWillSaveTextDocument(documentWillSave))
  // closed document listener, for locking
  sub.push(workspace.onDidCloseTextDocument(documentClosedListener))
  // Editor changed listener, updates context and icons
  sub.push(window.onDidChangeActiveTextEditor(activeTextEditorChangedListener))

  registerRevisionModel(context)

  const fav = FavouritesProvider.get()
  fav.storagePath = context.globalStoragePath
  sub.push(window.registerTreeDataProvider("abapfs.favorites", fav))
  // register connections tree view
  const connectionsProvider = ConnectionsProvider.get()
  sub.push(window.registerTreeDataProvider("abapfs.connections", connectionsProvider))
  // create transports tree view so we can programmatically reveal items
  const transportsProvider = TransportsProvider.get()
  const transportsTree = window.createTreeView("abapfs.transports", { treeDataProvider: transportsProvider })
  transportsProvider.setTreeView(transportsTree)
  sub.push(transportsTree)
  sub.push(window.registerTreeDataProvider("abapfs.abapgit", abapGitProvider))
  sub.push(window.registerTreeDataProvider("abapfs.dumps", dumpProvider))
  sub.push(window.registerTreeDataProvider("abapfs.atcFinds", atcProvider))
  sub.push(window.registerTreeDataProvider("abapfs.traces", tracesProvider))
  sub.push(window.registerWebviewViewProvider("abapfs.objectProperties", objectPropertiesProvider))
  sub.push(window.registerWebviewViewProvider("abapfs.views.objectSearch", new AbapObjectSearchProvider()))
  sub.push(getStatusBar())
  sub.push(
    languages.registerCodeLensProvider(
      { language: "abap", scheme: ADTSCHEME },
      ClassHierarchyLensProvider.get()
    )
  )
  sub.push(
    languages.registerCodeLensProvider(
      { language: "abap", scheme: ADTSCHEME },
      AbapRevisionLens.get()
    )
  )

  sub.push(
    languages.registerCodeLensProvider(
      { language: "abap", scheme: ADTSCHEME },
      IncludeProvider.get()
    )
  )

  sub.push(window.registerWebviewViewProvider(ATCDocumentation.viewType, ATCDocumentation.get()))
  sub.push(window.registerWebviewViewProvider(TableViewProvider.viewType, TableViewProvider.instance))
  sub.push(window.registerWebviewViewProvider(VariableTracker.viewType, VariableTracker.instance))

  sub.push(MessagesProvider.register(context))
  sub.push(HttpProvider.register(context))
  sub.push(WebGuiCustomEditorProvider.register(context))
  registerAbapDebugger(context)
  ExternalBreakpointManager.register(context)

  LanguageCommands.start(context)

  setContext("abapfs:extensionActive", true)
  restoreLocks()
  registerAbapGit(context)

  registerCommands(context)
  registerSCIDecorator(context)
  const elapsed = new Date().getTime() - startTime
  log(`Activated,pid=${process.pid}, activation time(ms):${elapsed}`)
  return api
}

// this method is called when your extension is deactivated
// it's important to kill these sessions as there might be an open process on the abap side
// most commonly because of locked sources.
// Locks will not be released until either explicitly closed or the session is terminates
// an open session can leave sources locked without any UI able to release them (except SM12 and the like)
export async function deactivate() {
  stopWebGuiProxy()
  if (hasLocks())
    window.showInformationMessage(
      "Locks will be dropped now. If the relevant editors are still open they will be restored later"
    )
  setContext("abapfs:extensionActive", false)
  return disconnect()
}

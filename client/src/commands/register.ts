import { ExtensionContext, commands } from "vscode"
import { abapcmds } from "."

// These exports ensure modules are loaded so their @command decorators execute
// This registers all commands in the abapcmds array used by registerCommands
export { AdtCommands } from "./commands"
export { IncludeProvider } from "../adt/includes"
export { LanguageCommands } from "../langClient"
export { ClassHierarchyLensProvider } from "../adt/classhierarchy"
export { GitCommands } from "../scm/abapGit/commands"
export { AbapRevisionCommands } from "../scm/abaprevisions/commands"

export const registerCommands = (context: ExtensionContext) => {
  for (const cmd of abapcmds)
    context.subscriptions.push(
      commands.registerCommand(cmd.name, cmd.func.bind(cmd.target))
    )
}

import { ExtensionContext, lm } from "vscode"
import { SearchTool } from "./search"
import { UnitTool } from "./unit"
import { ActivateTool } from "./activate"
import { GetTransportsTool, GetTransportDetailsTool, SearchTransportsTool } from "./transports"
import { ReadSourceTool, GetObjectStructureTool, GetObjectComponentsTool, OpenObjectTool } from "./objects"
import { GetSystemInfoTool, ListPackagesTool, ListConnectionsTool, GetPackageContentsTool } from "./system"
import { RunAtcCheckTool, GetDumpsTool, GetRevisionsTool } from "./diagnostics"

export const registerChatTools = (context: ExtensionContext) => {
  // Original tools
  context.subscriptions.push(lm.registerTool("abap_search", new SearchTool()))
  context.subscriptions.push(lm.registerTool("abap_unit", new UnitTool()))
  context.subscriptions.push(lm.registerTool("abap_activate", new ActivateTool()))

  // Transport tools
  context.subscriptions.push(lm.registerTool("abap_get_transports", new GetTransportsTool()))
  context.subscriptions.push(lm.registerTool("abap_get_transport_details", new GetTransportDetailsTool()))
  context.subscriptions.push(lm.registerTool("abap_search_transports", new SearchTransportsTool()))

  // Object tools
  context.subscriptions.push(lm.registerTool("abap_read_source", new ReadSourceTool()))
  context.subscriptions.push(lm.registerTool("abap_get_object_structure", new GetObjectStructureTool()))
  context.subscriptions.push(lm.registerTool("abap_get_object_components", new GetObjectComponentsTool()))
  context.subscriptions.push(lm.registerTool("abap_open_object", new OpenObjectTool()))

  // System tools
  context.subscriptions.push(lm.registerTool("abap_get_system_info", new GetSystemInfoTool()))
  context.subscriptions.push(lm.registerTool("abap_list_packages", new ListPackagesTool()))
  context.subscriptions.push(lm.registerTool("abap_list_connections", new ListConnectionsTool()))
  context.subscriptions.push(lm.registerTool("abap_get_package_contents", new GetPackageContentsTool()))

  // Diagnostics tools
  context.subscriptions.push(lm.registerTool("abap_run_atc", new RunAtcCheckTool()))
  context.subscriptions.push(lm.registerTool("abap_get_dumps", new GetDumpsTool()))
  context.subscriptions.push(lm.registerTool("abap_get_revisions", new GetRevisionsTool()))
}

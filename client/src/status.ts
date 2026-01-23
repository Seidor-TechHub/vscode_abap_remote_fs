import { StatusBarAlignment, StatusBarItem, window, ThemeColor } from "vscode"
import { AbapObject } from "abapobject"
import { uriAbapFile } from "./adt/operations/AdtObjectFinder"
import { ADTSCHEME } from "./adt/conections"

let statusBarItem: StatusBarItem

export function getStatusBar() {
    if (!statusBarItem) {
        statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100)
        statusBarItem.command = "abapfs.activate"
    }
    return statusBarItem
}

export function updateStatus(editor: import("vscode").TextEditor | undefined) {
    const item = getStatusBar()
    if (editor && editor.document.uri.scheme === ADTSCHEME) {
        const file = uriAbapFile(editor.document.uri)
        if (file && file.object) {
            const obj = file.object
            const version = obj.structure?.metaData["adtcore:version"]

            if (version === "inactive") {
                item.text = "$(circle-filled) Inactive"
                item.backgroundColor = new ThemeColor("statusBarItem.warningBackground")
                item.tooltip = "Object is inactive. Click to activate."
                item.show()
            } else if (version === "active") {
                item.text = "$(check) Active"
                item.backgroundColor = undefined
                item.tooltip = "Object is active"
                item.show()
            } else {
                item.hide()
            }
        } else {
            item.hide()
        }
    } else {
        item.hide()
    }
}

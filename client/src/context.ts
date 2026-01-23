import { commands } from "vscode"

export type AbapFsContexts = "abapfs:showActivate" |
    "abapfs:atc:autorefreshOn" |
    "abapfs:atc:exemptFilterOn" |
    "abapfs:atcdoc:navigation:back" |
    "abapfs:atcdoc:navigation:next" |
    "abapfs:extensionActive" |
    "abapfs:showTableContentIcon" |
    "abapfs:enableLeftPrevRev" |
    "abapfs:enableLeftNextRev" |
    "abapfs:enableRightPrevRev" |
    "abapfs:enableRightNextRev" |
    "abapfs:canShowInGui" |
    "abapfs:canRunInGui" |
    "abapfs:tableViewCanGoBack"

export const setContext = (key: AbapFsContexts, value: unknown) =>
    commands.executeCommand("setContext", key, value)

/**
 * Batch set multiple contexts at once
 * More efficient than calling setContext multiple times
 */
export const setContexts = (contexts: Partial<Record<AbapFsContexts, unknown>>) =>
    Promise.all(
        Object.entries(contexts).map(([key, value]) =>
            commands.executeCommand("setContext", key, value)
        )
    )

/**
 * Helper for common GUI context updates
 */
export const setGuiContexts = (canShow: boolean, canRun: boolean) =>
    setContexts({
        "abapfs:canShowInGui": canShow,
        "abapfs:canRunInGui": canRun
    })

/**
 * Helper for revision navigation context updates  
 */
export const setRevisionContexts = (
    leftPrev: boolean,
    leftNext: boolean,
    rightPrev: boolean,
    rightNext: boolean
) => setContexts({
    "abapfs:enableLeftPrevRev": leftPrev,
    "abapfs:enableLeftNextRev": leftNext,
    "abapfs:enableRightPrevRev": rightPrev,
    "abapfs:enableRightNextRev": rightNext
})
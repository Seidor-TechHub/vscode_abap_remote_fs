import {
    Diagnostic,
    DiagnosticCollection,
    DiagnosticSeverity,
    languages,
    Range,
    Uri
} from "vscode"
import { AtcFind } from "./view"

/**
 * DiagnosticCollection for ATC findings - integrates with VS Code's Problems panel
 * This provides native VS Code experience for viewing ABAP code issues
 */
let atcDiagnostics: DiagnosticCollection | undefined

/**
 * Get or create the ATC diagnostic collection
 */
export function getAtcDiagnostics(): DiagnosticCollection {
    if (!atcDiagnostics) {
        atcDiagnostics = languages.createDiagnosticCollection("abap-atc")
    }
    return atcDiagnostics
}

/**
 * Map ATC priority to VS Code DiagnosticSeverity
 * Priority 1 = Error, Priority 2 = Warning, others = Information
 */
function mapSeverity(priority: number): DiagnosticSeverity {
    switch (priority) {
        case 1: return DiagnosticSeverity.Error
        case 2: return DiagnosticSeverity.Warning
        case 3: return DiagnosticSeverity.Information
        default: return DiagnosticSeverity.Hint
    }
}

/**
 * Convert an AtcFind to a VS Code Diagnostic
 */
function findingToDiagnostic(finding: AtcFind): Diagnostic {
    const range = new Range(
        finding.start,
        finding.start.translate(0, 100) // End position at same line
    )

    const diagnostic = new Diagnostic(
        range,
        finding.finding.messageTitle,
        mapSeverity(finding.finding.priority)
    )

    diagnostic.source = "ATC"
    diagnostic.code = finding.finding.checkTitle

    return diagnostic
}

/**
 * Update the diagnostic collection with ATC findings
 * Groups findings by URI and sets them all at once for efficiency
 */
export function updateAtcDiagnostics(findings: AtcFind[]): void {
    const diagnostics = getAtcDiagnostics()

    // Group findings by URI
    const byUri = new Map<string, Diagnostic[]>()

    for (const finding of findings) {
        if (!finding.uri) continue

        const existing = byUri.get(finding.uri) || []
        existing.push(findingToDiagnostic(finding))
        byUri.set(finding.uri, existing)
    }

    // Clear existing and set all new diagnostics
    diagnostics.clear()

    for (const [uriString, diags] of byUri) {
        diagnostics.set(Uri.parse(uriString), diags)
    }
}

/**
 * Clear all ATC diagnostics
 */
export function clearAtcDiagnostics(): void {
    getAtcDiagnostics().clear()
}

/**
 * Dispose of the diagnostic collection
 */
export function disposeAtcDiagnostics(): void {
    if (atcDiagnostics) {
        atcDiagnostics.dispose()
        atcDiagnostics = undefined
    }
}

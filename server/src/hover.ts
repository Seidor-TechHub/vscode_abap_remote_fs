import {
  TextDocumentPositionParams,
  Hover,
  MarkupContent,
  MarkupKind
} from "vscode-languageserver"
import { clientAndObjfromUrl } from "./utilities"
import { log } from "./clientManager"
import { isAbap, caughtToString, isCdsView } from "./functions"
import { CompletionElementInfo, DdicElement, DdicProperties } from "abap-adt-api"

/**
 * Info about a local type definition
 */
interface LocalTypeInfo {
  name: string
  kind: "structure" | "table" | "simple"
  lineType?: string  // For table types, the line type
  fields?: Array<{ name: string; typeName: string }>  // For structures
  baseType?: string  // For simple types or variables
}

// Cache for class source code and parsed types (key: className, value: { source, types, timestamp })
const classSourceCache = new Map<string, {
  source: string
  types: Map<string, LocalTypeInfo>
  timestamp: number
}>()
const CLASS_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/**
 * Map of ABAP object type codes to human-readable names
 */
const OBJECT_TYPE_NAMES: { [key: string]: string } = {
  // Data Dictionary
  "DTEL/DE": "Data Element",
  "DOMA/DD": "Domain",
  "TABL/DT": "Table",
  "TABL/DS": "Structure",
  "VIEW/DV": "View",
  "TTYP/TT": "Table Type",
  "SHLP/SH": "Search Help",
  "ENQU/DL": "Lock Object",
  "DDLS/DF": "CDS View",
  "DCLS/DL": "CDS Access Control",
  "DDLX/EX": "CDS Metadata Extension",
  "STRU/DS": "Structure",
  
  // Classes and Interfaces
  "CLAS/OC": "Class",
  "CLAS/I": "Class Include",
  "INTF/OI": "Interface",
  
  // Programs and Includes
  "PROG/P": "Program",
  "PROG/I": "Include",
  "FUGR/F": "Function Group",
  "FUGR/FF": "Function Module",
  "FUGR/I": "Function Group Include",
  
  // Package/Development Class
  "DEVC/K": "Package",
  
  // Other
  "MSAG/N": "Message Class",
  "TRAN/T": "Transaction",
  "XSLT/XT": "XSLT Transformation",
  "AUTH/A": "Authorization Object",
  "ENHO/EH": "Enhancement Implementation",
  "ENHS/ES": "Enhancement Spot",
  "BDEF/BDO": "Behavior Definition",
  "SRVD/SRV": "Service Definition",
  "SRVB/SVB": "Service Binding",
  "WDYN/WD": "Web Dynpro Component",
  "WAPA/WA": "BSP Application",
  "SMIM/MI": "MIME Object",
  
  // Variables and parameters
  "variable": "Variable",
  "parameter": "Parameter",
  "field-symbol": "Field Symbol",
  "constant": "Constant",
  "type": "Type",
  "method": "Method",
  "attribute": "Attribute",
  "event": "Event"
}

/**
 * Translate ABAP object type code to human-readable name
 */
function getObjectTypeName(typeCode: string): string {
  if (!typeCode) return ""
  
  const upperCode = typeCode.toUpperCase()
  
  // Check direct match
  if (OBJECT_TYPE_NAMES[upperCode]) {
    return OBJECT_TYPE_NAMES[upperCode]
  }
  
  // Check lowercase match (for things like "variable", "parameter")
  if (OBJECT_TYPE_NAMES[typeCode.toLowerCase()]) {
    return OBJECT_TYPE_NAMES[typeCode.toLowerCase()]
  }
  
  // Try to extract the base type (e.g., "CLAS" from "CLAS/OC")
  const parts = upperCode.split("/")
  if (parts.length === 2) {
    const baseTypes: { [key: string]: string } = {
      "DTEL": "Data Element",
      "DOMA": "Domain",
      "TABL": "Table",
      "VIEW": "View",
      "TTYP": "Table Type",
      "SHLP": "Search Help",
      "ENQU": "Lock Object",
      "DDLS": "CDS View",
      "DCLS": "CDS Access Control",
      "DDLX": "CDS Metadata Extension",
      "STRU": "Structure",
      "CLAS": "Class",
      "INTF": "Interface",
      "PROG": "Program",
      "FUGR": "Function Group",
      "DEVC": "Package",
      "MSAG": "Message Class",
      "TRAN": "Transaction",
      "XSLT": "XSLT Transformation",
      "AUTH": "Authorization Object",
      "ENHO": "Enhancement Implementation",
      "ENHS": "Enhancement Spot",
      "BDEF": "Behavior Definition",
      "SRVD": "Service Definition",
      "SRVB": "Service Binding",
      "WDYN": "Web Dynpro",
      "WAPA": "BSP Application",
      "SMIM": "MIME Object"
    }
    if (baseTypes[parts[0]]) {
      return baseTypes[parts[0]]
    }
  }
  
  // Return original if no translation found
  return typeCode
}

/**
 * Translate property key to human-readable label
 */
function getPropertyLabel(key: string): string {
  const labels: { [key: string]: string } = {
    "parentName": "Package",
    "parentname": "Package",
    "package": "Package",
    "devclass": "Package",
    "responsible": "Author",
    "author": "Author",
    "createdBy": "Created By",
    "changedBy": "Changed By",
    "createdAt": "Created At",
    "changedAt": "Changed At",
    "description": "Description",
    "type": "Type",
    "name": "Name",
    "visibility": "Visibility",
    "isAbstract": "Abstract",
    "isFinal": "Final",
    "isStatic": "Static",
    "domain": "Domain",
    "dataElement": "Data Element",
    "dataType": "Data Type",
    "length": "Length",
    "decimals": "Decimals"
  }
  
  return labels[key.toLowerCase()] || labels[key] || key
}

/**
 * Format ABAP data type with length information
 */
function formatDataType(dataType: string, length?: number, decimals?: number): string {
  if (!dataType) return ""

  let result = dataType.toUpperCase()

  if (length && length > 0) {
    if (decimals && decimals > 0) {
      result += `(${length},${decimals})`
    } else {
      result += `(${length})`
    }
  }

  return result
}

/**
 * Get a readable type category
 */
function getTypeCategory(dataType: string): string {
  const type = dataType?.toUpperCase() || ""

  const categories: { [key: string]: string } = {
    "CHAR": "Character",
    "NUMC": "Numeric Character",
    "CLNT": "Client",
    "LANG": "Language",
    "CUKY": "Currency Key",
    "UNIT": "Unit",
    "DATS": "Date",
    "TIMS": "Time",
    "INT1": "Integer (1 byte)",
    "INT2": "Integer (2 bytes)",
    "INT4": "Integer (4 bytes)",
    "INT8": "Integer (8 bytes)",
    "DEC": "Packed Decimal",
    "CURR": "Currency",
    "QUAN": "Quantity",
    "FLTP": "Floating Point",
    "PREC": "Precision",
    "ACCP": "Accounting Period",
    "RAW": "Raw/Binary",
    "LRAW": "Long Raw",
    "RAWSTRING": "Raw String",
    "STRING": "String",
    "SSTRING": "Short String",
    "GEOM_EWKB": "Geometry",
    "D16D": "Decimal Float 16",
    "D34D": "Decimal Float 34",
    "DATN": "Date (New)",
    "TIMN": "Time (New)",
    "UTCL": "UTC Long Timestamp",
    "D16R": "Decimal Float 16 Raw",
    "D34R": "Decimal Float 34 Raw",
    "D16S": "Decimal Float 16 SAP",
    "D34S": "Decimal Float 34 SAP"
  }

  return categories[type] || type
}

/**
 * Format DDIC element properties into markdown (for header info only, not fields)
 */
function formatDdicPropertiesHeader(props: DdicProperties): string {
  const lines: string[] = []
  const ep = props.elementProps

  if (ep) {
    // Type info with readable category (only if it's a simple type, not a structure)
    const typeCategory = getTypeCategory(ep.ddicDataType)
    const formattedType = formatDataType(ep.ddicDataType, ep.ddicLength, ep.ddicDecimals)

    if (formattedType && ep.ddicDataType) {
      lines.push(`**Type:** \`${formattedType}\` (${typeCategory})`)
    }

    // Data Element info
    if (ep.ddicDataElement) {
      lines.push(`**Data Element:** \`${ep.ddicDataElement}\``)
    }

    // Description from labels
    const description = ep.ddicLabelMedium || ep.ddicLabelLong || ep.ddicLabelShort || ""
    if (description) {
      lines.push(`**Description:** ${description}`)
    }
  }

  return lines.join("\n")
}

/**
 * Format a DDIC element (structure/table type) with its fields as a table
 */
function formatDdicElement(element: DdicElement, depth: number = 0): string {
  const lines: string[] = []

  // Element header with human-readable type
  const typeName = getObjectTypeName(element.type)
  lines.push(`### ${element.name}`)
  lines.push(`**${typeName}**`)

  // Get description from properties
  const ep = element.properties?.elementProps
  const description = ep?.ddicLabelMedium || ep?.ddicLabelLong || ep?.ddicLabelShort || ""
  if (description) {
    lines.push("")
    lines.push(description)
  }

  // Children (fields for structures, etc.) - format as nice table
  if (element.children && element.children.length > 0) {
    const fields: FieldInfo[] = element.children.map(child => {
      const childEp = child.properties?.elementProps
      return {
        name: child.name,
        typeName: childEp?.ddicDataElement || child.name,
        dataElement: childEp?.ddicDataElement || "",
        dataType: childEp?.ddicDataType || "",
        length: childEp?.ddicLength || 0,
        decimals: childEp?.ddicDecimals || 0,
        description: childEp?.ddicLabelMedium || childEp?.ddicLabelShort || childEp?.ddicLabelLong || "",
        isKey: childEp?.ddicIsKey
      }
    })
    
    lines.push("")
    lines.push("**Fields:**")
    lines.push("")
    lines.push(...renderFieldTable(fields))
  } else {
    // No children - show simple type info
    const headerProps = formatDdicPropertiesHeader(element.properties)
    if (headerProps) {
      lines.push("")
      lines.push(headerProps)
    }
  }

  return lines.join("\n")
}

/**
 * Try to get DDIC element info for CDS/table fields
 */
async function getDdicElementInfo(
  client: any,
  elementPath: string
): Promise<DdicElement | undefined> {
  try {
    const result = await client.ddicElement(elementPath)
    return result
  } catch (e) {
    return undefined
  }
}

/**
 * Structure field info for display
 */
interface FieldInfo {
  name: string
  typeName: string
  dataElement: string
  dataType: string
  length: number
  decimals: number
  description: string
  isKey?: boolean
}

/**
 * Format a length string from type info
 */
function formatLengthString(dataType: string, length: number, decimals: number): string {
  if (!dataType || length <= 0) return ""
  const typeCategory = getTypeCategory(dataType).toLowerCase()
  return decimals > 0 
    ? `${typeCategory}(${length},${decimals})`
    : `${typeCategory}(${length})`
}

/**
 * Render a field table from an array of FieldInfo objects
 * Returns array of markdown lines for the table
 */
function renderFieldTable(fields: FieldInfo[]): string[] {
  if (fields.length === 0) return []
  
  const lines: string[] = []
  lines.push("| Field | Type | Description | Length |")
  lines.push("|-------|------|-------------|--------|")
  
  for (const field of fields) {
    const keyMarker = field.isKey ? "🔑 " : ""
    const lengthStr = formatLengthString(field.dataType, field.length, field.decimals)
    lines.push(`| ${keyMarker}\`${field.name}\` | \`${field.typeName}\` | ${field.description} | ${lengthStr} |`)
  }
  
  return lines
}

/**
 * Extract field information from completion component
 * Also extracts DDIC info directly from entries if available (for CDS/DDIC structures)
 */
function extractFieldFromComponent(comp: any): FieldInfo {
  let fieldName = comp["adtcore:name"] || ""
  let fieldType = ""
  let dataElement = ""
  let dataType = ""
  let length = 0
  let decimals = 0
  let description = ""

  if (comp.entries) {
    for (const entry of comp.entries) {
      const key = entry.key?.toLowerCase() || ""
      const value = entry.value || ""
      
      // Field name might be in an empty key, "name" key, or "Table" key (for CDS)
      if ((key === "" || key === "name" || key === "table") && value && !fieldName) {
        fieldName = value
      }
      
      // Get the ABAP type (for local types)
      if (key === "abaptype") {
        // Extract just the type name from "TYPE MATNR" format
        fieldType = value.replace(/^TYPE\s+/i, "").trim()
      }
      
      // Get DDIC info directly from entries (for CDS/DDIC structures)
      if (key === "ddicdataelement") {
        dataElement = value
        if (!fieldType) fieldType = value
      }
      if (key === "ddicdatatype") {
        dataType = value.toUpperCase()
      }
      if (key === "ddiclength") {
        length = parseInt(value, 10) || 0
      }
      if (key === "ddicdecimals") {
        decimals = parseInt(value, 10) || 0
      }
      // Check all variations of description keys (camelCase and lowercase)
      if (key === "ddiclabel" || key === "ddiclabelmedium" || key === "ddiclabelshort" || 
          key === "ddiclabellong" || key === "description") {
        if (!description) description = value
      }
    }
  }

  return { name: fieldName, typeName: fieldType, dataElement, dataType, length, decimals, description }
}

/**
 * Batch fetch data element details from DDIC for multiple data elements at once
 * This is much faster than fetching one at a time
 */
async function batchGetDataElementDetails(client: any, dataElementNames: string[]): Promise<Map<string, {
  dataType: string
  length: number
  decimals: number
  description: string
}>> {
  const results = new Map<string, { dataType: string; length: number; decimals: number; description: string }>()
  
  if (!client || dataElementNames.length === 0) return results

  const upperNames = dataElementNames.map(n => n.toUpperCase())
  const uniqueNames = [...new Set(upperNames)]
  
  if (uniqueNames.length === 0) return results

  try {
    // Batch query for DD04L (technical details)
    const inClause = uniqueNames.map(n => `'${n}'`).join(',')
    const query = `SELECT ROLLNAME, DATATYPE, LENG, DECIMALS FROM DD04L WHERE ROLLNAME IN (${inClause})`
    
    const result = await client.runQuery(query, uniqueNames.length)
    
    if (result && result.values) {
      for (const row of result.values) {
        const rollname = row.ROLLNAME || row["ROLLNAME"] || ""
        const dataType = row.DATATYPE || row["DATATYPE"] || ""
        const length = parseInt(row.LENG || row["LENG"], 10) || 0
        const decimals = parseInt(row.DECIMALS || row["DECIMALS"], 10) || 0
        
        results.set(rollname, { dataType, length, decimals, description: "" })
      }
    }

    // Batch query for DD04T (descriptions) - try user's language first, then English
    if (results.size > 0) {
      const foundNames = [...results.keys()]
      const textInClause = foundNames.map(n => `'${n}'`).join(',')
      
      // Get all available descriptions in Spanish and English
      const textQuery = `SELECT ROLLNAME, DDLANGUAGE, DDTEXT FROM DD04T WHERE ROLLNAME IN (${textInClause}) AND DDLANGUAGE IN ('S', 'E')`
      const textResult = await client.runQuery(textQuery, foundNames.length * 2)
      
      if (textResult && textResult.values) {
        // Group by rollname, prefer Spanish over English
        const descByName = new Map<string, { S?: string; E?: string }>()
        
        for (const row of textResult.values) {
          const rollname = row.ROLLNAME || row["ROLLNAME"] || ""
          const lang = row.DDLANGUAGE || row["DDLANGUAGE"] || ""
          const text = row.DDTEXT || row["DDTEXT"] || ""
          
          if (!descByName.has(rollname)) {
            descByName.set(rollname, {})
          }
          descByName.get(rollname)![lang as 'S' | 'E'] = text
        }
        
        // Update results with descriptions (prefer Spanish)
        for (const [rollname, langs] of descByName) {
          const existing = results.get(rollname)
          if (existing) {
            existing.description = langs.S || langs.E || ""
          }
        }
      }
    }
  } catch (e) {
    // Query failed, return empty results
  }

  return results
}

/**
 * Parse ABAP source to find local type definitions
 * Returns a map of type name -> type info
 */
function parseLocalTypes(source: string): Map<string, LocalTypeInfo> {
  const types = new Map<string, LocalTypeInfo>()
  
  // Normalize source - remove comments and normalize whitespace
  const cleanSource = source
    .replace(/\*.*$/gm, "")  // Remove line comments starting with *
    .replace(/".*$/gm, "")   // Remove line comments starting with "
    .replace(/\r\n/g, "\n")
  
  // Find structure definitions: TYPES: BEGIN OF xxx, ... END OF xxx
  const structRegex = /TYPES\s*:\s*BEGIN\s+OF\s+(\w+)\s*,([^]*?)END\s+OF\s+\1/gi
  let match
  while ((match = structRegex.exec(cleanSource)) !== null) {
    const typeName = match[1].toUpperCase()
    const fieldsBlock = match[2]
    
    // Parse fields
    const fields: Array<{ name: string; typeName: string }> = []
    const fieldRegex = /(\w+)\s+TYPE\s+(\w+)/gi
    let fieldMatch
    while ((fieldMatch = fieldRegex.exec(fieldsBlock)) !== null) {
      fields.push({
        name: fieldMatch[1].toUpperCase(),
        typeName: fieldMatch[2].toUpperCase()
      })
    }
    
    types.set(typeName, {
      name: typeName,
      kind: "structure",
      fields
    })
  }
  
  // Find table type definitions: xxx TYPE [STANDARD|SORTED|HASHED] TABLE OF yyy
  const tableTypeRegex = /(\w+)\s+TYPE\s+(?:STANDARD\s+|SORTED\s+|HASHED\s+)?TABLE\s+OF\s+(\w+)/gi
  while ((match = tableTypeRegex.exec(cleanSource)) !== null) {
    const typeName = match[1].toUpperCase()
    const lineType = match[2].toUpperCase()
    
    // Don't overwrite if we already have a structure definition
    if (!types.has(typeName)) {
      types.set(typeName, {
        name: typeName,
        kind: "table",
        lineType
      })
    }
  }
  
  // Find DATA declarations: DATA: xxx TYPE yyy or DATA xxx TYPE yyy
  const dataRegex = /DATA\s*:?\s*(\w+)\s+TYPE\s+(?:(?:STANDARD\s+|SORTED\s+|HASHED\s+)?TABLE\s+OF\s+)?(\w+)/gi
  while ((match = dataRegex.exec(cleanSource)) !== null) {
    const varName = match[1].toUpperCase()
    const typeName = match[2].toUpperCase()
    
    if (!types.has(varName)) {
      types.set(varName, {
        name: varName,
        kind: "simple",
        baseType: typeName
      })
    }
  }
  
  return types
}

/**
 * Get class types with caching - fetches class source and parses types
 */
async function getClassTypesWithCache(
  client: any,
  className: string
): Promise<Map<string, LocalTypeInfo>> {
  const upperClassName = className.toUpperCase()
  const now = Date.now()
  
  // Check cache
  const cached = classSourceCache.get(upperClassName)
  if (cached && (now - cached.timestamp) < CLASS_CACHE_TTL) {
    return cached.types
  }
  try {
    // Fetch the class source
    const sourceLink = `/sap/bc/adt/oo/classes/${className.toLowerCase()}/source/main`
    const classContent = await client.getObjectSource(sourceLink)
    
    if (classContent) {
      const classSource = typeof classContent === "string" ? classContent : classContent.toString()
      // Parse the type definitions
      const classTypes = parseLocalTypes(classSource)
      // Cache it
      classSourceCache.set(upperClassName, {
        source: classSource,
        types: classTypes,
        timestamp: now
      })
      
      return classTypes
    }
  } catch (e) {
    // Silently ignore
  }
  
  return new Map()
}

/**
 * Resolve a local type to its structure fields by following type chain
 */
function resolveLocalTypeToStructure(
  typeName: string,
  localTypes: Map<string, LocalTypeInfo>,
  depth: number = 0
): LocalTypeInfo | undefined {
  if (depth > 10) return undefined  // Prevent infinite recursion
  
  const upperName = typeName.toUpperCase()
  const typeInfo = localTypes.get(upperName)
  
  if (!typeInfo) return undefined
  
  if (typeInfo.kind === "structure") {
    return typeInfo
  }
  
  if (typeInfo.kind === "table" && typeInfo.lineType) {
    // Resolve the line type
    return resolveLocalTypeToStructure(typeInfo.lineType, localTypes, depth + 1)
  }
  
  if (typeInfo.kind === "simple" && typeInfo.baseType) {
    // Resolve the base type
    return resolveLocalTypeToStructure(typeInfo.baseType, localTypes, depth + 1)
  }
  
  return undefined
}

/**
 * Get the type chain for display (e.g., "gt_output -> tty_output -> ty_output")
 */
function getTypeChain(
  typeName: string,
  localTypes: Map<string, LocalTypeInfo>,
  depth: number = 0
): string[] {
  if (depth > 10) return []
  
  const upperName = typeName.toUpperCase()
  const typeInfo = localTypes.get(upperName)
  
  if (!typeInfo) return []
  
  if (typeInfo.kind === "structure") {
    return [upperName]
  }
  
  if (typeInfo.kind === "table" && typeInfo.lineType) {
    return [upperName, ...getTypeChain(typeInfo.lineType, localTypes, depth + 1)]
  }
  
  if (typeInfo.kind === "simple" && typeInfo.baseType) {
    return [upperName, ...getTypeChain(typeInfo.baseType, localTypes, depth + 1)]
  }
  
  return [upperName]
}

/**
 * Format CompletionElementInfo into hover markdown
 * Now async to fetch field details from DDIC
 */
async function formatCompletionElement(info: CompletionElementInfo, client?: any, source?: string, sourceUrl?: string): Promise<string> {
  const lines: string[] = []

  // Header with name and human-readable type
  lines.push(`### ${info.name}`)
  if (info.type) {
    const typeName = getObjectTypeName(info.type)
    // Only show type if it's different from the raw code (i.e., we have a translation)
    if (typeName !== info.type) {
      lines.push(`**${typeName}**`)
    } else {
      lines.push(`**Type:** \`${info.type}\``)
    }
  }

  // Documentation
  if (info.doc) {
    lines.push("")
    lines.push(info.doc)
  }

  // Handle inline declarations with undefined type (DATA(var) = ...)
  // Need to parse source to find the assignment and resolve the type
  const isUndefinedType = info.type === "undefined" || info.type === undefined || !info.type
  
  if (isUndefinedType && client && source) {
    const varName = info.name.toUpperCase()
    
    // First, check if this is a structure field access (e.g., ls_mat_info-matnr)
    // Look for pattern: structurename-fieldname where fieldname matches varName
    const fieldAccessRegex = new RegExp(
      `(\\w+)\\s*-\\s*${varName}\\b`,
      "i"
    )
    const fieldAccessMatch = source.match(fieldAccessRegex)
    
    if (fieldAccessMatch) {
      const structureName = fieldAccessMatch[1].toUpperCase()
      // Try to get info about this field from DDIC directly (it might be a data element)
      const deDetails = await batchGetDataElementDetails(client, [varName])
      const fieldInfo = deDetails.get(varName)
      
      if (fieldInfo && (fieldInfo.description || fieldInfo.dataType)) {
        lines.push(`**Field of:** \`${structureName}\``)
        
        if (fieldInfo.description) {
          lines.push("")
          lines.push(`**Description:** ${fieldInfo.description}`)
        }
        if (fieldInfo.dataType && fieldInfo.length > 0) {
          const typeCategory = getTypeCategory(fieldInfo.dataType)
          const lengthStr = fieldInfo.decimals > 0 
            ? `${fieldInfo.dataType}(${fieldInfo.length},${fieldInfo.decimals})`
            : `${fieldInfo.dataType}(${fieldInfo.length})`
          lines.push(`**Type:** ${typeCategory} - \`${lengthStr}\``)
        }
        
        return lines.join("\n")
      }
    }
    
    // Look for inline DATA declaration: DATA(varname) = class=>method(...) or similar
    const inlineDataRegex = new RegExp(
      `DATA\\s*\\(\\s*${varName}\\s*\\)\\s*=\\s*([\\w_]+)(?:=>|->)([\\w_]+)\\s*\\(`,
      "i"
    )
    const inlineMatch = source.match(inlineDataRegex)
    
    if (inlineMatch) {
      const className = inlineMatch[1].toUpperCase()
      const methodName = inlineMatch[2].toUpperCase()
      lines.push(`**Inline Variable**`)
      lines.push("")
      lines.push(`Assigned from: \`${className}=>${methodName}()\``)
      
      // Find the position of the method name in the source to get its info
      const methodCallRegex = new RegExp(`(${className})\\s*(=>|->)\\s*(${methodName})`, "gi")
      let methodCallMatch
      let methodLine = 0
      let methodCol = 0
      
      // Find the method call position
      const sourceLines = source.split("\n")
      for (let i = 0; i < sourceLines.length; i++) {
        const lineText = sourceLines[i]
        methodCallMatch = methodCallRegex.exec(lineText)
        if (methodCallMatch) {
          methodLine = i + 1 // 1-based
          // Position cursor on the method name
          methodCol = methodCallMatch.index + methodCallMatch[1].length + methodCallMatch[2].length + methodCallMatch[3].length / 2
          break
        }
        methodCallRegex.lastIndex = 0 // Reset for next line
      }
      
      if (methodLine > 0) {
        try {
          // Get method info by calling codeCompletionElement on the method name position
          const methodInfo = await client.codeCompletionElement(
            sourceUrl || "",
            source,
            methodLine,
            Math.floor(methodCol)
          )
          if (methodInfo && methodInfo.components) {
            // Look for RETURNING parameter in method signature
            for (const comp of methodInfo.components) {
              if (comp.entries) {
                let isReturning = false
                let returnType = ""
                
                for (const entry of comp.entries) {
                  const key = entry.key?.toLowerCase() || ""
                  if (key === "paramtype" && entry.value === "returning") {
                    isReturning = true
                  }
                  if (key === "abaptype" && entry.value) {
                    returnType = entry.value.replace(/^TYPE\s+/i, "").trim()
                  }
                }
                
                if (isReturning && returnType) {
                  lines.push("")
                  lines.push(`**Return type:** \`${returnType}\``)
                  
                  // Try to get the type definition using codeCompletionElement
                  // For class-scoped types like ZCL_UTILS_MAT=>TT_MAT_INFO, we need to
                  // find where the type is used in code and get info there
                  let typeChildren: any[] = []
                  
                  // First try ddicElement
                  try {
                    const typeInfo = await client.ddicElement(returnType)
                    if (typeInfo && typeInfo.children && typeInfo.children.length > 0) {
                      typeChildren = typeInfo.children
                    }
                  } catch (e) {
                    // Silently ignore
                  }
                  
                  // If ddicElement didn't work, fetch the class source and parse the type definition
                  if (typeChildren.length === 0 && returnType.includes("=>")) {
                    const [typClassName, typeTypeName] = returnType.split("=>")
                    // Get class types with caching
                    const classTypes = await getClassTypesWithCache(client, typClassName)
                    
                    if (classTypes.size > 0) {
                      // Look for the table type first
                      const tableTypeInfo = classTypes.get(typeTypeName.toUpperCase())
                      
                      let structureTypeName = typeTypeName
                      if (tableTypeInfo && tableTypeInfo.kind === "table" && tableTypeInfo.lineType) {
                        structureTypeName = tableTypeInfo.lineType
                      }
                      
                      // Now get the structure definition
                      const structureInfo = classTypes.get(structureTypeName.toUpperCase())
                      
                      if (structureInfo && structureInfo.kind === "structure" && structureInfo.fields) {
                        lines.push("")
                        if (tableTypeInfo && tableTypeInfo.kind === "table") {
                          lines.push(`**Line type:** \`${structureTypeName}\``)
                          lines.push("")
                        }
                        lines.push("**Fields:**")
                        lines.push("")
                        
                        // Get DDIC details for field types
                        const fieldTypeNames = structureInfo.fields.map((f: any) => f.typeName)
                        const batchDetails = await batchGetDataElementDetails(client, fieldTypeNames)
                        
                        const fields: FieldInfo[] = structureInfo.fields.map((field: any) => {
                          const batchInfo = batchDetails.get(field.typeName.toUpperCase())
                          return {
                            name: field.name,
                            typeName: field.typeName,
                            dataElement: "",
                            dataType: batchInfo?.dataType || "",
                            length: batchInfo?.length || 0,
                            decimals: batchInfo?.decimals || 0,
                            description: batchInfo?.description || ""
                          }
                        })
                        lines.push(...renderFieldTable(fields))
                        
                        return lines.join("\n")
                      }
                    }
                  }
                  
                  if (typeChildren.length > 0) {
                      lines.push("")
                      lines.push("**Fields:**")
                      lines.push("")
                      
                      const fieldTypeNames = typeChildren
                        .map((child: any) => child.properties?.elementProps?.ddicDataElement || child.name)
                        .filter(Boolean)
                      const batchDetails = await batchGetDataElementDetails(client, fieldTypeNames)
                      
                      const fields: FieldInfo[] = typeChildren.map((child: any) => {
                        const childEp = child.properties?.elementProps
                        const fieldTypeName = childEp?.ddicDataElement || child.name
                        const batchInfo = batchDetails.get(fieldTypeName?.toUpperCase())
                        
                        let description = childEp?.ddicLabelMedium || childEp?.ddicLabelShort || ""
                        if (!description && batchInfo) description = batchInfo.description || ""
                        
                        // Prefer batch info, fallback to childEp
                        const dataType = batchInfo?.dataType || childEp?.ddicDataType || ""
                        const length = batchInfo?.length || childEp?.ddicLength || 0
                        const decimals = batchInfo?.decimals || childEp?.ddicDecimals || 0
                        
                        return {
                          name: child.name,
                          typeName: fieldTypeName,
                          dataElement: "",
                          dataType,
                          length,
                          decimals,
                          description
                        }
                      })
                      lines.push(...renderFieldTable(fields))
                      
                      return lines.join("\n")
                  }
                }
              }
            }
          }
        } catch (e) {
          // Silently ignore
        }
      }
      
      // If we couldn't resolve the full type, still return what we have
      return lines.join("\n")
    }
    
    // Generic: C  if this variable is a line item from any table
    // Look for any pattern where varName appears to be extracted from a table
    // This handles LOOP AT, READ TABLE, table expressions, ASSIGN, etc.
    const tableLinePatterns = [
      // Any pattern with table followed by ... varName (captures table name)
      new RegExp(`(?:LOOP\\s+AT|READ\\s+TABLE|ASSIGN)\\s+(\\w+)(?:\\s|\\[|\\()+.*?(?:INTO|ASSIGNING|TO)\\s+(?:DATA|FIELD-SYMBOL)?\\s*\\(?\\s*<?${varName}>?\\s*\\)?`, "is"),
      // DATA(varName) = table[ ... ]
      new RegExp(`DATA\\s*\\(\\s*${varName}\\s*\\)\\s*=\\s*(\\w+)\\s*\\[`, "i"),
      // table[ ... ] INTO DATA(varName)
      new RegExp(`(\\w+)\\s*\\[.*?\\].*?(?:INTO|TO)\\s+(?:DATA|FIELD-SYMBOL)?\\s*\\(?\\s*<?${varName}>?\\s*\\)?`, "is"),
    ]
    
    let tableVar = ""
    for (const pattern of tableLinePatterns) {
      const match = source.match(pattern)
      if (match && match[1]) {
        tableVar = match[1].toUpperCase()
        break
      }
    }
    
    if (tableVar) {
      // Helper function to show fields from a structure
      const showStructureFields = async (structureInfo: LocalTypeInfo, lineTypeLabel?: string) => {
        if (structureInfo.kind === "structure" && structureInfo.fields) {
          if (lineTypeLabel) {
            lines.push(`**Line type:** \`${lineTypeLabel}\``)
            lines.push("")
          }
          lines.push("**Fields:**")
          lines.push("")
          
          const fieldTypeNames = structureInfo.fields.map(f => f.typeName)
          const batchDetails = await batchGetDataElementDetails(client, fieldTypeNames)
          
          const fields: FieldInfo[] = structureInfo.fields.map(field => {
            const batchInfo = batchDetails.get(field.typeName.toUpperCase())
            return {
              name: field.name,
              typeName: field.typeName,
              dataElement: "",
              dataType: batchInfo?.dataType || "",
              length: batchInfo?.length || 0,
              decimals: batchInfo?.decimals || 0,
              description: batchInfo?.description || ""
            }
          })
          lines.push(...renderFieldTable(fields))
          return true
        }
        return false
      }
      
      // Resolve the table's line type
      const localTypes = parseLocalTypes(source)
      let resolved = false
      
      // 1. Check if table is a local variable with a type
      const tableTypeInfo = localTypes.get(tableVar)
      if (tableTypeInfo) {
        if (tableTypeInfo.kind === "simple" && tableTypeInfo.baseType) {
          const baseType = localTypes.get(tableTypeInfo.baseType.toUpperCase())
          if (baseType && baseType.kind === "table" && baseType.lineType) {
            const structureInfo = resolveLocalTypeToStructure(baseType.lineType, localTypes)
            if (structureInfo) {
              lines.push(`**Line of:** \`${tableVar}\``)
              lines.push("")
              resolved = await showStructureFields(structureInfo, baseType.lineType)
            }
          }
        } else if (tableTypeInfo.kind === "table" && tableTypeInfo.lineType) {
          const structureInfo = resolveLocalTypeToStructure(tableTypeInfo.lineType, localTypes)
          if (structureInfo) {
            lines.push(`**Line of:** \`${tableVar}\``)
            lines.push("")
            resolved = await showStructureFields(structureInfo, tableTypeInfo.lineType)
          }
        }
      }
      
      // 2. Check if table is an inline variable from a method call
      if (!resolved) {
        const tableInlineRegex = new RegExp(
          `DATA\\s*\\(\\s*${tableVar}\\s*\\)\\s*=\\s*([\\w_]+)(?:=>|->)([\\w_]+)\\s*\\(`,
          "i"
        )
        const tableInlineMatch = source.match(tableInlineRegex)
        if (tableInlineMatch) {
          const className = tableInlineMatch[1].toUpperCase()
          const methodName = tableInlineMatch[2].toUpperCase()
          
          // Get method return type
          const methodCallRegex = new RegExp(`(${className})\\s*(=>|->)\\s*(${methodName})`, "gi")
          const sourceLines = source.split("\n")
          for (let i = 0; i < sourceLines.length; i++) {
            const methodCallMatch = methodCallRegex.exec(sourceLines[i])
            if (methodCallMatch) {
              try {
                const methodInfo = await client.codeCompletionElement(
                  sourceUrl || "", source, i + 1,
                  Math.floor(methodCallMatch.index + methodCallMatch[0].length / 2)
                )
                
                if (methodInfo?.components) {
                  for (const comp of methodInfo.components) {
                    if (!comp.entries) continue
                    let isReturning = false, returnType = ""
                    for (const entry of comp.entries) {
                      if (entry.key?.toLowerCase() === "paramtype" && entry.value === "returning") isReturning = true
                      if (entry.key?.toLowerCase() === "abaptype") returnType = entry.value?.replace(/^TYPE\s+/i, "").trim() || ""
                    }
                    
                    if (isReturning && returnType?.includes("=>")) {
                      const [typClassName, typeTypeName] = returnType.split("=>")
                      const classTypes = await getClassTypesWithCache(client, typClassName)
                      const tableType = classTypes.get(typeTypeName.toUpperCase())
                      
                      if (tableType?.kind === "table" && tableType.lineType) {
                        const structureInfo = classTypes.get(tableType.lineType.toUpperCase())
                        if (structureInfo) {
                          lines.push(`**Line of:** \`${tableVar}\``)
                          lines.push(`**Table type:** \`${returnType}\``)
                          lines.push("")
                          resolved = await showStructureFields(structureInfo, tableType.lineType)
                        }
                      }
                      break
                    }
                  }
                }
              } catch (e) {
                // Silently ignore
              }
              break
            }
            methodCallRegex.lastIndex = 0
          }
        }
      }
      
      if (resolved) {
        return lines.join("\n")
      } else {
        // At least show what we know
        lines.push(`**Line of:** \`${tableVar}\``)
        return lines.join("\n")
      }
    }
    
    // Also check for VALUE #(...) or other inline constructs
    const valueRegex = new RegExp(
      `DATA\\s*\\(\\s*${varName}\\s*\\)\\s*=\\s*VALUE\\s+([\\w_]+)\\s*\\(`,
      "i"
    )
    const valueMatch = source.match(valueRegex)
    if (valueMatch) {
      const typeName = valueMatch[1].toUpperCase()
      if (typeName !== "#") {
        lines.push(`**Inline Variable**`)
        lines.push("")
        lines.push(`**Type:** \`${typeName}\``)
        
        // Try to resolve this type from local types
        const localTypes = parseLocalTypes(source)
        const structureInfo = resolveLocalTypeToStructure(typeName, localTypes)
        
        if (structureInfo && structureInfo.kind === "structure" && structureInfo.fields) {
          lines.push("")
          lines.push("**Fields:**")
          lines.push("")
          
          const fieldTypeNames = structureInfo.fields.map(f => f.typeName)
          const batchDetails = await batchGetDataElementDetails(client, fieldTypeNames)
          
          const fields: FieldInfo[] = structureInfo.fields.map(field => {
            const batchInfo = batchDetails.get(field.typeName.toUpperCase())
            return {
              name: field.name,
              typeName: field.typeName,
              dataElement: "",
              dataType: batchInfo?.dataType || "",
              length: batchInfo?.length || 0,
              decimals: batchInfo?.decimals || 0,
              description: batchInfo?.description || ""
            }
          })
          lines.push(...renderFieldTable(fields))
          
          return lines.join("\n")
        }
      }
    }
  }

  // Handle SELECT-OPTIONS (PROG/PD) - show data element info for the field it's based on
  const isSelectOption = info.type === "PROG/PD"
  if (isSelectOption && client && source) {
    // Try to find the SELECT-OPTIONS declaration in source
    const selectOptRegex = new RegExp(
      `SELECT-OPTIONS\\s+${info.name}\\s+FOR\\s+([\\w_-]+)`,
      "i"
    )
    const selectOptMatch = source.match(selectOptRegex)
    
    if (selectOptMatch) {
      const forField = selectOptMatch[1]
      lines.push(`**Select-Options for:** \`${forField}\``)
      
      // Try to get the data element info for the field
      const fieldParts = forField.split("-")
      if (fieldParts.length >= 2) {
        const fieldName = fieldParts[fieldParts.length - 1].toUpperCase()
        
        // Get DDIC info for the field's data element
        const deDetails = await batchGetDataElementDetails(client, [fieldName])
        const fieldInfo = deDetails.get(fieldName)
        
        if (fieldInfo) {
          if (fieldInfo.description) {
            lines.push("")
            lines.push(`**Description:** ${fieldInfo.description}`)
          }
          if (fieldInfo.dataType && fieldInfo.length > 0) {
            const typeCategory = getTypeCategory(fieldInfo.dataType)
            const lengthStr = fieldInfo.decimals > 0 
              ? `${fieldInfo.dataType}(${fieldInfo.length},${fieldInfo.decimals})`
              : `${fieldInfo.dataType}(${fieldInfo.length})`
            lines.push(`**Type:** ${typeCategory} - \`${lengthStr}\``)
          }
        }
      }
      
      return lines.join("\n")
    }
  }

  // Handle program-local variables (PROG/PLA) and types (PROG/PLY)
  // These have empty components, so we need to parse the source code
  const isProgramLocalVariable = info.type === "PROG/PLA"
  const isProgramLocalType = info.type === "PROG/PLY"
  
  if ((isProgramLocalVariable || isProgramLocalType) && client && source) {
    // Parse local types from source code
    const localTypes = parseLocalTypes(source)
    // Get the type chain (e.g., GT_OUTPUT -> TTY_OUTPUT -> TY_OUTPUT)
    const typeChain = getTypeChain(info.name, localTypes)
    
    // Resolve to the underlying structure
    const structureInfo = resolveLocalTypeToStructure(info.name, localTypes)
    
    if (structureInfo && structureInfo.kind === "structure" && structureInfo.fields) {
      // Show the type chain if there's more than one level
      if (typeChain.length > 1) {
        lines.push("")
        lines.push(`**Type chain:** ${typeChain.join(" → ")}`)
      }
      
      // Show the fields
      lines.push("")
      lines.push("**Fields:**")
      lines.push("")
      
      // Batch fetch DDIC details for all field types
      const fieldTypeNames = structureInfo.fields.map(f => f.typeName)
      const batchDetails = await batchGetDataElementDetails(client, fieldTypeNames)
      
      const fields: FieldInfo[] = structureInfo.fields.map(field => {
        const batchInfo = batchDetails.get(field.typeName.toUpperCase())
        return {
          name: field.name,
          typeName: field.typeName,
          dataElement: "",
          dataType: batchInfo?.dataType || "",
          length: batchInfo?.length || 0,
          decimals: batchInfo?.decimals || 0,
          description: batchInfo?.description || ""
        }
      })
      lines.push(...renderFieldTable(fields))
      
      return lines.join("\n")
    }
    
    // Fallback: Try DDIC lookup if no local structure found
    // This handles cases where local type references a DDIC type
    const localTypeInfo = localTypes.get(info.name.toUpperCase())
    let ddicTypeName = ""
    
    if (localTypeInfo) {
      if (localTypeInfo.kind === "table" && localTypeInfo.lineType) {
        ddicTypeName = localTypeInfo.lineType
      } else if (localTypeInfo.kind === "simple" && localTypeInfo.baseType) {
        ddicTypeName = localTypeInfo.baseType
      }
    }
    
    if (ddicTypeName) {
      try {
        const typeInfo = await client.ddicElement(ddicTypeName)
        if (typeInfo && typeInfo.children && typeInfo.children.length > 0) {
          lines.push("")
          lines.push(`**Based on:** \`${ddicTypeName}\``)
          lines.push("")
          lines.push("**Fields:**")
          lines.push("")

          const fieldTypeNames = typeInfo.children
            .map((child: any) => child.properties?.elementProps?.ddicDataElement || child.name)
            .filter(Boolean)
          const batchDetails = await batchGetDataElementDetails(client, fieldTypeNames)

          const fields: FieldInfo[] = typeInfo.children.map((child: any) => {
            const childEp = child.properties?.elementProps
            const fieldTypeName = childEp?.ddicDataElement || child.name
            const batchInfo = batchDetails.get(fieldTypeName?.toUpperCase())
            
            let description = childEp?.ddicLabelMedium || childEp?.ddicLabelShort || childEp?.ddicLabelLong || ""
            if (!description && batchInfo?.description) description = batchInfo.description
            
            // Prefer batch info, fallback to childEp
            const dataType = batchInfo?.dataType || childEp?.ddicDataType || ""
            const length = batchInfo?.length || childEp?.ddicLength || 0
            const decimals = batchInfo?.decimals || childEp?.ddicDecimals || 0
            
            return {
              name: child.name,
              typeName: fieldTypeName,
              dataElement: "",
              dataType,
              length,
              decimals,
              description,
              isKey: childEp?.ddicIsKey
            }
          })
          lines.push(...renderFieldTable(fields))
          
          return lines.join("\n")
        }
      } catch (e) {
        // Silently ignore
      }
    }
  }
  
  // Legacy handling for program local types (when source not available)
  if ((isProgramLocalVariable || isProgramLocalType) && client && !source) {
    // For program local types/variables, try to get the structure definition
    // The doc might contain type information like "TYPE tty_output"
    let typeName = ""
    
    // Try to extract type from doc field (e.g., "TYPE tty_output")
    if (info.doc) {
      const typeMatch = info.doc.match(/TYPE\s+(STANDARD\s+TABLE\s+OF\s+|SORTED\s+TABLE\s+OF\s+|HASHED\s+TABLE\s+OF\s+)?(\w+)/i)
      if (typeMatch) {
        typeName = typeMatch[2] // Get the type name
      }
    }
    
    // Try to get type info using codeCompletionElement on the type name itself
    if (typeName && typeName.toUpperCase() !== info.name.toUpperCase()) {
      lines.push("")
      lines.push(`**Based on:** \`${typeName}\``)
      
      // Try DDIC lookup for the underlying type (works for DDIC types)
      try {
        const typeInfo = await client.ddicElement(typeName)
        if (typeInfo && typeInfo.children && typeInfo.children.length > 0) {
          // It's a DDIC structure - show its fields
          lines.push("")
          lines.push("**Fields:**")
          lines.push("")

          const fieldTypeNames = typeInfo.children
            .map((child: any) => child.properties?.elementProps?.ddicDataElement || child.name)
            .filter(Boolean)
          const batchDetails = await batchGetDataElementDetails(client, fieldTypeNames)

          const fields: FieldInfo[] = typeInfo.children.map((child: any) => {
            const childEp = child.properties?.elementProps
            const fieldTypeName = childEp?.ddicDataElement || child.name
            const batchInfo = batchDetails.get(fieldTypeName?.toUpperCase())
            
            let description = childEp?.ddicLabelMedium || childEp?.ddicLabelShort || childEp?.ddicLabelLong || ""
            if (!description && batchInfo?.description) description = batchInfo.description
            
            const dataType = batchInfo?.dataType || childEp?.ddicDataType || ""
            const length = batchInfo?.length || childEp?.ddicLength || 0
            const decimals = batchInfo?.decimals || childEp?.ddicDecimals || 0
            
            return {
              name: child.name,
              typeName: fieldTypeName,
              dataElement: "",
              dataType,
              length,
              decimals,
              description,
              isKey: childEp?.ddicIsKey
            }
          })
          lines.push(...renderFieldTable(fields))
          
          return lines.join("\n")
        }
      } catch (e) {
        // Silently ignore
      }
    }
  }

  // For variables, parameters, etc., try to get the underlying type and show its structure
  const isVariableOrParameter = info.type?.toLowerCase() === "variable" || info.type?.toLowerCase() === "parameter"
  if (isVariableOrParameter && client && info.components && info.components.length > 0) {
    // Look for the underlying type name from components
    let underlyingTypeName = ""
    for (const comp of info.components) {
      if (comp.entries) {
        for (const entry of comp.entries) {
          const key = entry.key?.toLowerCase() || ""
          // Look for type references in various formats
          if (key === "abaptype" || key === "type" || key === "rowtype" || key === "linetype") {
            underlyingTypeName = entry.value?.replace(/^TYPE\s+(TABLE\s+OF\s+)?/i, "").trim() || ""
            break
          }
        }
      }
      if (underlyingTypeName) break
    }

    // If we found an underlying type, try to show its structure
    if (underlyingTypeName) {
      lines.push("")
      lines.push(`**Based on:** \`${underlyingTypeName}\``)
      
      try {
        const typeInfo = await client.ddicElement(underlyingTypeName)
        if (typeInfo) {
          // Check if this is a table type (has rowType property)
          const ep = typeInfo.properties?.elementProps
          const rowType = (ep as any)?.ddicRowType || (ep as any)?.rowType || (ep as any)?.lineType
          
          if (rowType) {
            // It's a table type - show the line type's structure
            lines.push(`**Table of:** \`${rowType}\``)
            
            try {
              const rowTypeInfo = await client.ddicElement(rowType)
              if (rowTypeInfo && rowTypeInfo.children && rowTypeInfo.children.length > 0) {
                lines.push("")
                lines.push("**Fields:**")
                lines.push("")

                // Batch fetch DDIC details
                const fieldTypeNames = rowTypeInfo.children
                  .map((child: any) => child.properties?.elementProps?.ddicDataElement || child.name)
                  .filter(Boolean)
                const batchDetails = await batchGetDataElementDetails(client, fieldTypeNames)

                const fields: FieldInfo[] = rowTypeInfo.children.map((child: any) => {
                  const childEp = child.properties?.elementProps
                  const fieldTypeName = childEp?.ddicDataElement || child.name
                  const batchInfo = batchDetails.get(fieldTypeName?.toUpperCase())
                  
                  let description = childEp?.ddicLabelMedium || childEp?.ddicLabelShort || childEp?.ddicLabelLong || ""
                  if (!description && batchInfo?.description) description = batchInfo.description
                  
                  const dataType = batchInfo?.dataType || childEp?.ddicDataType || ""
                  const length = batchInfo?.length || childEp?.ddicLength || 0
                  const decimals = batchInfo?.decimals || childEp?.ddicDecimals || 0
                  
                  return {
                    name: child.name,
                    typeName: fieldTypeName,
                    dataElement: "",
                    dataType,
                    length,
                    decimals,
                    description,
                    isKey: childEp?.ddicIsKey
                  }
                })
                lines.push(...renderFieldTable(fields))
                
                return lines.join("\n")
              }
            } catch (e) {
              // Row type lookup failed
            }
          } else if (typeInfo.children && typeInfo.children.length > 0) {
            // It's a structure - show its fields
            lines.push("")
            lines.push("**Fields:**")
            lines.push("")

            // Batch fetch DDIC details for all fields
            const fieldTypeNames = typeInfo.children
              .map((child: any) => child.properties?.elementProps?.ddicDataElement || child.name)
              .filter(Boolean)
            const batchDetails = await batchGetDataElementDetails(client, fieldTypeNames)

            const fields: FieldInfo[] = typeInfo.children.map((child: any) => {
              const childEp = child.properties?.elementProps
              const fieldTypeName = childEp?.ddicDataElement || child.name
              const batchInfo = batchDetails.get(fieldTypeName?.toUpperCase())
              
              let description = childEp?.ddicLabelMedium || childEp?.ddicLabelShort || childEp?.ddicLabelLong || ""
              if (!description && batchInfo?.description) description = batchInfo.description
              
              const dataType = batchInfo?.dataType || childEp?.ddicDataType || ""
              const length = batchInfo?.length || childEp?.ddicLength || 0
              const decimals = batchInfo?.decimals || childEp?.ddicDecimals || 0
              
              return {
                name: child.name,
                typeName: fieldTypeName,
                dataElement: "",
                dataType,
                length,
                decimals,
                description,
                isKey: childEp?.ddicIsKey
              }
            })
            lines.push(...renderFieldTable(fields))
            
            return lines.join("\n")
          }
        }
      } catch (e) {
        // DDIC lookup failed, continue with normal display
      }
    }
  }

  // Special handling for Table Types - get the line type and show its structure
  const isTableType = info.type === "TTYP/TT"
  if (isTableType && client) {
    // Try to get the line type from components
    let lineTypeName = ""
    if (info.components && info.components.length > 0) {
      for (const comp of info.components) {
        if (comp.entries) {
          for (const entry of comp.entries) {
            // Look for entries that might indicate the line type
            const key = entry.key?.toLowerCase() || ""
            if (key === "rowtype" || key === "linetype" || key === "abaptype") {
              lineTypeName = entry.value?.replace(/^TYPE\s+/i, "").trim() || ""
              break
            }
          }
        }
        if (lineTypeName) break
      }
    }

    // If we found a line type, fetch its structure
    if (lineTypeName) {
      lines.push("")
      lines.push(`**Table of:** \`${lineTypeName}\``)
      
      try {
        const lineTypeInfo = await client.ddicElement(lineTypeName)
        if (lineTypeInfo && lineTypeInfo.children && lineTypeInfo.children.length > 0) {
          lines.push("")
          lines.push("**Fields:**")
          lines.push("")

          const fields: FieldInfo[] = lineTypeInfo.children.map((child: any) => {
            const childEp = child.properties?.elementProps
            return {
              name: child.name,
              typeName: childEp?.ddicDataElement || child.name,
              dataElement: "",
              dataType: childEp?.ddicDataType || "",
              length: childEp?.ddicLength || 0,
              decimals: childEp?.ddicDecimals || 0,
              description: childEp?.ddicLabelMedium || childEp?.ddicLabelShort || childEp?.ddicLabelLong || "",
              isKey: childEp?.ddicIsKey
            }
          })
          lines.push(...renderFieldTable(fields))
          
          return lines.join("\n")
        }
      } catch (e) {
        // Silently ignore
      }
    }
    
    // If no line type found, try to get it from DDIC directly
    try {
      const ddicInfo = await client.ddicElement(info.name)
      if (ddicInfo) {
        // Check for rowType property or similar
        const ep = ddicInfo.properties?.elementProps
        if (ep) {
          const rowType = (ep as any).ddicRowType || (ep as any).rowType || (ep as any).lineType
          if (rowType) {
            lines.push("")
            lines.push(`**Table of:** \`${rowType}\``)
            
            // Fetch the row type structure
            try {
              const rowTypeInfo = await client.ddicElement(rowType)
              if (rowTypeInfo && rowTypeInfo.children && rowTypeInfo.children.length > 0) {
                lines.push("")
                lines.push("**Fields:**")
                lines.push("")

                const fields: FieldInfo[] = rowTypeInfo.children.map((child: any) => {
                  const childEp = child.properties?.elementProps
                  return {
                    name: child.name,
                    typeName: childEp?.ddicDataElement || child.name,
                    dataElement: "",
                    dataType: childEp?.ddicDataType || "",
                    length: childEp?.ddicLength || 0,
                    decimals: childEp?.ddicDecimals || 0,
                    description: childEp?.ddicLabelMedium || childEp?.ddicLabelShort || childEp?.ddicLabelLong || "",
                    isKey: childEp?.ddicIsKey
                  }
                })
                lines.push(...renderFieldTable(fields))
                
                return lines.join("\n")
              }
            } catch (e) {
              // Silently ignore
            }
          }
        }
        
        // If the table type itself has children (unlikely but check anyway)
        if (ddicInfo.children && ddicInfo.children.length > 0) {
          return formatDdicElement(ddicInfo, 0)
        }
      }
    } catch (e) {
      // Silently ignore
    }
  }

  // Special handling for Methods - show parameters grouped by category
  // A method can be detected by: info.type === "method" OR "CLAS/OM" OR components have paramType entries
  const hasParamTypeEntries = info.components?.some(c => 
    c.entries?.some(e => e.key?.toLowerCase() === "paramtype")
  ) || false
  const isMethod = info.type?.toLowerCase() === "method" || info.type === "CLAS/OM" || hasParamTypeEntries
  
  if (isMethod && info.components && info.components.length > 0) {
    // Group parameters by their paramType
    const importing: Array<{ name: string; type: string; description: string; optional: boolean; byValue: boolean }> = []
    const exporting: Array<{ name: string; type: string; description: string; byValue: boolean }> = []
    const changing: Array<{ name: string; type: string; description: string; optional: boolean }> = []
    const returning: Array<{ name: string; type: string; description: string; optional: boolean }> = []
    const exceptions: Array<{ name: string; description: string }> = []
    const raising: Array<{ name: string; description: string }> = []

    for (const comp of info.components) {
      if (!comp.entries) continue
      
      let paramName = comp["adtcore:name"] || ""
      let paramType = ""
      let abapType = ""
      let description = ""
      let isOptional = false
      let isByValue = false
      let isException = false
      let isRaising = false

      for (const entry of comp.entries) {
        const key = entry.key?.toLowerCase() || ""
        // Value can be string or boolean at runtime despite TypeScript types
        const value = entry.value as unknown
        const valueStr = String(value ?? "").toLowerCase()

        if (key === "paramtype") {
          paramType = valueStr
        } else if (key === "abaptype") {
          abapType = String(value ?? "").replace(/^TYPE\s+/i, "").trim()
        } else if (key === "optional" && (value === true || valueStr === "true")) {
          isOptional = true
        } else if (key === "byvalue" && (value === true || valueStr === "true")) {
          isByValue = true
        } else if (key === "description" || key === "ddiclabel" || key === "ddiclabelmedium") {
          if (!description) description = String(value ?? "")
        } else if (key === "exception" && (value === true || valueStr === "true")) {
          isException = true
        } else if (key === "raising" && (value === true || valueStr === "true")) {
          isRaising = true
        }
      }

      // If no paramName from adtcore:name, try to get from entries
      if (!paramName) {
        for (const entry of comp.entries) {
          if ((entry.key === "" || entry.key?.toLowerCase() === "name") && entry.value) {
            paramName = String(entry.value)
            break
          }
        }
      }

      if (!paramName) continue

      // Categorize the parameter
      if (isException || paramType === "exception") {
        exceptions.push({ name: paramName, description })
      } else if (isRaising || paramType === "raising") {
        raising.push({ name: paramName, description })
      } else if (paramType === "importing") {
        importing.push({ name: paramName, type: abapType, description, optional: isOptional, byValue: isByValue })
      } else if (paramType === "exporting") {
        exporting.push({ name: paramName, type: abapType, description, byValue: isByValue })
      } else if (paramType === "changing") {
        changing.push({ name: paramName, type: abapType, description, optional: isOptional })
      } else if (paramType === "returning") {
        returning.push({ name: paramName, type: abapType, description, optional: isOptional })
      }
    }

    // Format parameters grouped by category
    // IMPORTING
    if (importing.length > 0) {
      lines.push("")
      lines.push("**IMPORTING**")
      for (const param of importing) {
        const valuePrefix = param.byValue ? "VALUE(" : ""
        const valueSuffix = param.byValue ? ")" : ""
        const typeStr = param.type ? ` TYPE \`${param.type}\`` : ""
        const optStr = param.optional ? " *(optional)*" : ""
        const descStr = param.description ? ` — *${param.description}*` : ""
        lines.push(`- ${valuePrefix}\`${param.name}\`${valueSuffix}${typeStr}${optStr}${descStr}`)
      }
    }
    
    // EXPORTING
    if (exporting.length > 0) {
      lines.push("")
      lines.push("**EXPORTING**")
      for (const param of exporting) {
        const valuePrefix = param.byValue ? "VALUE(" : ""
        const valueSuffix = param.byValue ? ")" : ""
        const typeStr = param.type ? ` TYPE \`${param.type}\`` : ""
        const descStr = param.description ? ` — *${param.description}*` : ""
        lines.push(`- ${valuePrefix}\`${param.name}\`${valueSuffix}${typeStr}${descStr}`)
      }
    }
    
    // CHANGING
    if (changing.length > 0) {
      lines.push("")
      lines.push("**CHANGING**")
      for (const param of changing) {
        const typeStr = param.type ? ` TYPE \`${param.type}\`` : ""
        const optStr = param.optional ? " *(optional)*" : ""
        const descStr = param.description ? ` — *${param.description}*` : ""
        lines.push(`- \`${param.name}\`${typeStr}${optStr}${descStr}`)
      }
    }
    
    // RETURNING
    if (returning.length > 0) {
      lines.push("")
      lines.push("**RETURNING**")
      for (const param of returning) {
        const typeStr = param.type ? ` TYPE \`${param.type}\`` : ""
        const optStr = param.optional ? " *(optional)*" : ""
        const descStr = param.description ? ` — *${param.description}*` : ""
        lines.push(`- VALUE(\`${param.name}\`)${typeStr}${optStr}${descStr}`)
      }
    }
    
    // RAISING
    if (raising.length > 0) {
      lines.push("")
      lines.push("**RAISING**")
      for (const exc of raising) {
        const descStr = exc.description ? ` — *${exc.description}*` : ""
        lines.push(`- \`${exc.name}\`${descStr}`)
      }
    }
    
    // EXCEPTIONS
    if (exceptions.length > 0) {
      lines.push("")
      lines.push("**EXCEPTIONS**")
      for (const exc of exceptions) {
        const descStr = exc.description ? ` — *${exc.description}*` : ""
        lines.push(`- \`${exc.name}\`${descStr}`)
      }
    }

    return lines.join("\n")
  }

  // Special handling for Classes and Interfaces - show methods with their info
  const isClassOrInterface = info.type === "CLAS/OC" || info.type === "INTF/OI"
  if (isClassOrInterface && info.components && info.components.length > 0) {
    // Group components by type (methods, attributes, events, types, constants)
    const methods: Array<{ 
      name: string; 
      description: string; 
      visibility: string;
      importing: string[];
      exporting: string[];
      changing: string[];
      returning: string[];
      exceptions: string[];
    }> = []
    const attributes: Array<{ name: string; type: string; description: string; visibility: string }> = []
    const events: Array<{ name: string; description: string; visibility: string }> = []
    const types: Array<{ name: string; description: string; visibility: string }> = []
    const constants: Array<{ name: string; type: string; value: string; description: string; visibility: string }> = []

    // First pass: identify methods and collect their parameters
    // The components for a class might be flat (each parameter is a separate component)
    // or they might be grouped by method
    
    // Collect all components that look like method parameters
    const methodParams = new Map<string, {
      importing: string[];
      exporting: string[];
      changing: string[];
      returning: string[];
      exceptions: string[];
    }>()
    
    // Map to store method signatures with parameters and description
    const methodSignatures = new Map<string, {
      importing: string[];
      exporting: string[];
      changing: string[];
      returning: string[];
      description: string;
    }>()
    
    // For each method, fetch its parameter details using the same API that works when hovering on a single method
    // This gives us the CLAS/OOP components with full parameter info
    if (client && sourceUrl) {
      // Get the list of method names first
      const methodNames = info.components
        .filter((c: any) => (c["adtcore:type"] || "").toLowerCase() === "clas/om")
        .map((c: any) => c["adtcore:name"])
      
      // Fetch each method's details in parallel
      const methodInfoPromises = methodNames.map(async (methodName: string) => {
        try {
          // Call the code completion element API for this specific method
          const methodInfo = await getElementInfoByName(client, sourceUrl, info.name, methodName)
          if (methodInfo) {
            const params = {
              importing: [] as string[],
              exporting: [] as string[],
              changing: [] as string[],
              returning: [] as string[],
              exceptions: [] as string[],
              description: methodInfo.doc || ""  // Capture the method description
            }
            
            if (methodInfo.components) {
              for (const comp of methodInfo.components) {
                const compType = (comp["adtcore:type"] || "").toLowerCase()
                if (compType === "clas/oop") {
                  const paramName = comp["adtcore:name"] || ""
                  let paramType = ""
                  let paramKind = ""
                  
                  if (comp.entries) {
                    for (const entry of comp.entries) {
                      const key = (entry.key || "").toLowerCase()
                      const val = String(entry.value || "")
                      if (key === "paramtype") paramKind = val.toLowerCase()
                      if (key === "abaptype") paramType = val.replace(/^TYPE\s+/i, "").trim()
                    }
                  }
                  
                  const paramStr = paramType ? `${paramName}: ${paramType}` : paramName
                  
                  if (paramKind === "importing") params.importing.push(paramStr)
                  else if (paramKind === "exporting") params.exporting.push(paramStr)
                  else if (paramKind === "changing") params.changing.push(paramStr)
                  else if (paramKind === "returning") params.returning.push(paramStr)
                  else if (paramKind === "raising" || paramKind === "exception") params.exceptions.push(paramName)
                }
              }
            }
            
            return { name: methodName.toUpperCase(), params }
          }
        } catch (e) {
          // Silently ignore - method info not available
        }
        return null
      })
      
      const methodResults = await Promise.all(methodInfoPromises)
      for (const result of methodResults) {
        if (result) {
          methodSignatures.set(result.name, result.params)
        }
      }
    }
    
    for (const comp of info.components) {
      const compType = (comp["adtcore:type"] || "").toLowerCase()
      const compName = comp["adtcore:name"] || ""
      
      // Skip packages (DEVC/K) and empty names
      if (!compName) continue
      if (compType === "devc/k") continue

      let description = ""
      let abapType = ""
      let visibility = ""
      let value = ""
      let paramType = ""
      let componentKind = ""
      let parentMethod = ""

      if (comp.entries) {
        for (const entry of comp.entries) {
          const key = entry.key?.toLowerCase() || ""
          const val = entry.value
          const valStr = String(val || "")

          if (key === "description" || key === "ddiclabel" || key === "ddiclabelmedium") {
            if (!description) description = valStr
          } else if (key === "abaptype") {
            abapType = valStr.replace(/^TYPE\s+/i, "").trim()
          } else if (key === "visibility") {
            visibility = valStr
          } else if (key === "value") {
            value = valStr
          } else if (key === "paramtype") {
            paramType = valStr.toLowerCase()
          } else if (key === "kind" || key === "componentkind") {
            componentKind = valStr.toLowerCase()
          } else if (key === "method" || key === "parentmethod") {
            parentMethod = valStr
          }
        }
      }

      const upperName = compName.toUpperCase()
      const isTypeName = upperName.startsWith("TY_") || upperName.startsWith("TT_") || 
                         upperName.startsWith("TR_") || upperName.startsWith("TS_") ||
                         upperName.endsWith("_TYPE") || upperName.endsWith("_TAB") ||
                         upperName.endsWith("_RANGE")
      
      const isMethodType = compType === "method" || compType.includes("method") || componentKind === "method"
      const isParameter = paramType !== ""
      const isTypeType = (compType === "type" || compType.includes("type") || 
                         componentKind === "type" || isTypeName) && !isParameter
      const isAttributeType = (compType === "attribute" || compType.includes("attribute") || 
                              compType.includes("data") || componentKind === "attribute") && !isParameter
      const isConstantType = (compType === "constant" || compType.includes("constant") || 
                             componentKind === "constant") && !isParameter
      const isEventType = (compType === "event" || compType.includes("event") || 
                          componentKind === "event") && !isParameter
      
      // Categorize
      if (isConstantType) {
        constants.push({ name: compName, type: abapType, value, description, visibility })
      } else if (isEventType) {
        events.push({ name: compName, description, visibility })
      } else if (isTypeType) {
        types.push({ name: compName, description, visibility })
      } else if (isAttributeType) {
        attributes.push({ name: compName, type: abapType, description, visibility })
      } else if (isMethodType) {
        methods.push({ 
          name: compName, 
          description, 
          visibility,
          importing: [],
          exporting: [],
          changing: [],
          returning: [],
          exceptions: []
        })
      } else if (isParameter && parentMethod) {
        // This is a parameter belonging to a method
        if (!methodParams.has(parentMethod)) {
          methodParams.set(parentMethod, {
            importing: [],
            exporting: [],
            changing: [],
            returning: [],
            exceptions: []
          })
        }
        const params = methodParams.get(parentMethod)!
        const paramStr = abapType ? `${compName}: ${abapType}` : compName
        
        if (paramType === "importing") {
          params.importing.push(paramStr)
        } else if (paramType === "exporting") {
          params.exporting.push(paramStr)
        } else if (paramType === "changing") {
          params.changing.push(paramStr)
        } else if (paramType === "returning") {
          params.returning.push(paramStr)
        } else if (paramType === "exception" || paramType === "raising") {
          params.exceptions.push(compName)
        }
      } else if (!isTypeType && !isAttributeType && !isConstantType && !isEventType && !isParameter) {
        // Default: treat as method
        methods.push({ 
          name: compName, 
          description, 
          visibility,
          importing: [],
          exporting: [],
          changing: [],
          returning: [],
          exceptions: []
        })
      }
    }
    
    // Merge parameter info into methods from methodSignatures (fetched via API)
    for (const method of methods) {
      const sig = methodSignatures.get(method.name.toUpperCase())
      if (sig) {
        method.importing = sig.importing
        method.exporting = sig.exporting
        method.changing = sig.changing
        method.returning = sig.returning
        if (sig.description) {
          method.description = sig.description
        }
      }
      
      // Also try methodParams (from component entries)
      const params = methodParams.get(method.name)
      if (params) {
        if (method.importing.length === 0) method.importing = params.importing
        if (method.exporting.length === 0) method.exporting = params.exporting
        if (method.changing.length === 0) method.changing = params.changing
        if (method.returning.length === 0) method.returning = params.returning
        if (method.exceptions.length === 0) method.exceptions = params.exceptions
      }
    }

    // Format methods - each method as a section with parameters grouped
    if (methods.length > 0) {
      lines.push("")
      lines.push("---")
      lines.push("**Methods:**")
      
      let isFirstMethod = true
      for (const method of methods) {
        if (!isFirstMethod) {
          lines.push("")
          lines.push("---")
        }
        isFirstMethod = false
        
        lines.push("")
        const vis = method.visibility ? ` (${method.visibility})` : ""
        lines.push(`#### \`${method.name}\`${vis}`)
        
        if (method.description) {
          lines.push(`*${method.description}*`)
        }
        
        // IMPORTING
        if (method.importing.length > 0) {
          lines.push("")
          lines.push("**IMPORTING**")
          for (const param of method.importing) {
            lines.push(`- \`${param}\``)
          }
        }
        
        // EXPORTING
        if (method.exporting.length > 0) {
          lines.push("")
          lines.push("**EXPORTING**")
          for (const param of method.exporting) {
            lines.push(`- \`${param}\``)
          }
        }
        
        // CHANGING
        if (method.changing.length > 0) {
          lines.push("")
          lines.push("**CHANGING**")
          for (const param of method.changing) {
            lines.push(`- \`${param}\``)
          }
        }
        
        // RETURNING
        if (method.returning.length > 0) {
          lines.push("")
          lines.push("**RETURNING**")
          for (const param of method.returning) {
            lines.push(`- VALUE(\`${param}\`)`)
          }
        }
        
        // EXCEPTIONS
        if (method.exceptions.length > 0) {
          lines.push("")
          lines.push("**RAISING**")
          for (const exc of method.exceptions) {
            lines.push(`- \`${exc}\``)
          }
        }
      }
    }

    // Format types in a table
    if (types.length > 0) {
      lines.push("")
      lines.push("**Types:**")
      lines.push("")
      lines.push("| Type | Visibility | Description |")
      lines.push("|------|------------|-------------|")
      for (const type of types) {
        const vis = type.visibility || ""
        const desc = type.description || ""
        lines.push(`| \`${type.name}\` | ${vis} | ${desc} |`)
      }
    }

    // Format attributes
    if (attributes.length > 0) {
      lines.push("")
      lines.push("**Attributes:**")
      for (const attr of attributes) {
        const typeStr = attr.type ? ` TYPE \`${attr.type}\`` : ""
        const visMarker = attr.visibility ? ` *[${attr.visibility}]*` : ""
        const descStr = attr.description ? ` — *${attr.description}*` : ""
        lines.push(`- \`${attr.name}\`${typeStr}${visMarker}${descStr}`)
      }
    }

    // Format events
    if (events.length > 0) {
      lines.push("")
      lines.push("**Events:**")
      for (const event of events) {
        const visMarker = event.visibility ? ` *[${event.visibility}]*` : ""
        const descStr = event.description ? ` — *${event.description}*` : ""
        lines.push(`- \`${event.name}\`${visMarker}${descStr}`)
      }
    }

    // Format constants
    if (constants.length > 0) {
      lines.push("")
      lines.push("**Constants:**")
      for (const constant of constants) {
        const typeStr = constant.type ? ` TYPE \`${constant.type}\`` : ""
        const valStr = constant.value ? ` = \`${constant.value}\`` : ""
        const visMarker = constant.visibility ? ` *[${constant.visibility}]*` : ""
        const descStr = constant.description ? ` — *${constant.description}*` : ""
        lines.push(`- \`${constant.name}\`${typeStr}${valStr}${visMarker}${descStr}`)
      }
    }

    return lines.join("\n")
  }

  // Components (for structures, classes, etc.)
  if (info.components && info.components.length > 0) {
    // Check if this is a method-like component (has paramType entries)
    const hasParamTypeEntries = info.components.some(c => 
      c.entries?.some(e => e.key?.toLowerCase() === "paramtype")
    )
    
    // Check if this looks like a structure with multiple field components
    // Can be detected by: abaptype entries (local types) OR ddicDataType entries (CDS/DDIC structures)
    // But NOT if it has paramType entries (which indicates method parameters)
    const isStructureWithFields = !hasParamTypeEntries && info.components.length > 1 && 
      info.components.some(c => c.entries?.some(e => 
        e.key === "" || 
        e.key.toLowerCase() === "abaptype" || 
        e.key.toLowerCase() === "name" ||
        e.key.toLowerCase() === "ddicdatatype" ||
        e.key.toLowerCase() === "ddicdataelement"
      ))

    // Special case: CDS view/structure with single component but multiple field entries
    // Entries are grouped by "Table:" key which indicates field name
    const tableEntryCount = info.components.length === 1 
      ? info.components[0].entries?.filter((e: any) => e.key?.toLowerCase() === "table").length || 0
      : 0
    const isCdsStructureWithEntries = tableEntryCount > 1

    if (isStructureWithFields) {
      // Extract all fields first (without DDIC lookup)
      const fieldsToProcess: { fieldInfo: FieldInfo, needsLookup: boolean }[] = []
      
      for (const comp of info.components) {
        const fieldInfo = extractFieldFromComponent(comp)
        if (!fieldInfo.name) continue

        // Use dataElement as typeName if typeName is empty
        if (!fieldInfo.typeName && fieldInfo.dataElement) {
          fieldInfo.typeName = fieldInfo.dataElement
        }

        // Check if we need DDIC lookup (if we don't have dataType, OR don't have description, OR don't have length)
        const needsLookup = client && fieldInfo.typeName && (!fieldInfo.dataType || !fieldInfo.description || !fieldInfo.length)
        fieldsToProcess.push({ fieldInfo, needsLookup })
      }

      // Batch fetch all DDIC details in one query for better performance
      if (client) {
        const typeNamesToLookup = fieldsToProcess
          .filter(f => f.needsLookup)
          .map(f => f.fieldInfo.typeName)
          .filter(Boolean)

        if (typeNamesToLookup.length > 0) {
          const batchDetails = await batchGetDataElementDetails(client, typeNamesToLookup)
          
          // Apply batch results to fields
          for (const { fieldInfo, needsLookup } of fieldsToProcess) {
            if (needsLookup && fieldInfo.typeName) {
              const details = batchDetails.get(fieldInfo.typeName.toUpperCase())
              if (details) {
                if (!fieldInfo.dataType && details.dataType) {
                  fieldInfo.dataType = details.dataType
                }
                if (!fieldInfo.length && details.length) {
                  fieldInfo.length = details.length
                }
                if (!fieldInfo.decimals && details.decimals) {
                  fieldInfo.decimals = details.decimals
                }
                if (!fieldInfo.description && details.description) {
                  fieldInfo.description = details.description
                }
              }
            }
          }
        }
      }

      const fields = fieldsToProcess.map(f => f.fieldInfo)

      // Format as a table of fields
      lines.push("")
      lines.push("**Fields:**")
      lines.push("")
      lines.push(...renderFieldTable(fields))
    } else if (isCdsStructureWithEntries) {
      // CDS view/structure with entries grouped by "Table:" key
      // Parse entries into fields by grouping entries between "Table:" keys
      const comp = info.components[0]
      const entries = comp.entries || []
      const fields: FieldInfo[] = []
      let currentField: FieldInfo | null = null

      for (const entry of entries) {
        const key = entry.key?.toLowerCase() || ""
        const value = entry.value || ""

        if (key === "table") {
          // Start a new field
          if (currentField && currentField.name) {
            fields.push(currentField)
          }
          currentField = {
            name: value,
            typeName: "",
            dataElement: "",
            dataType: "",
            length: 0,
            decimals: 0,
            description: ""
          }
        } else if (currentField) {
          // Add data to current field
          if (key === "ddicdataelement") {
            currentField.dataElement = value
            if (!currentField.typeName) currentField.typeName = value
          } else if (key === "ddicdatatype") {
            currentField.dataType = value.toUpperCase()
          } else if (key === "ddiclength") {
            currentField.length = parseInt(value, 10) || 0
          } else if (key === "ddicdecimals") {
            currentField.decimals = parseInt(value, 10) || 0
          } else if (key === "ddiclabel" || key === "ddiclabelmedium" || key === "ddiclabelshort" || 
                     key === "ddiclabellong" || key === "description") {
            if (!currentField.description) currentField.description = value
          }
        }
      }
      // Don't forget the last field
      if (currentField && currentField.name) {
        fields.push(currentField)
      }

      // Format as a table of fields
      if (fields.length > 0) {
        lines.push("")
        lines.push("**Fields:**")
        lines.push("")
        lines.push(...renderFieldTable(fields))
      }
    } else {
      // Single component or non-structure - show details
      for (const comp of info.components) {
        lines.push("")
        const compTypeName = getObjectTypeName(comp["adtcore:type"])
        if (comp["adtcore:name"]) {
          lines.push(`**${compTypeName}:** \`${comp["adtcore:name"]}\``)
        }

        if (comp.entries && comp.entries.length > 0) {
          // Filter out empty keys and format nicely
          const meaningfulEntries = comp.entries.filter((e: any) => e.key && e.value)
          
          if (meaningfulEntries.length > 0) {
            for (const entry of meaningfulEntries) {
              const label = getPropertyLabel(entry.key)
              let value = entry.value
              
              // Format type values
              if (entry.key.toLowerCase() === "abaptype") {
                // Show just the type cleanly
                value = value.replace(/^TYPE\s+/i, "")
                lines.push(`- **Type:** \`${value}\``)
              } else if (entry.key.toLowerCase() === "globaltype") {
                // Skip globalType, not useful for user
                continue
              } else if (entry.key.toLowerCase() === "type") {
                value = getObjectTypeName(value)
                lines.push(`- **${label}:** \`${value}\``)
              } else {
                lines.push(`- **${label}:** \`${value}\``)
              }
            }
          }
        }
      }
    }
  }

  return lines.join("\n")
}

/**
 * Get element info for a specific class method by constructing a source that calls it
 */
async function getElementInfoByName(
  client: any,
  sourceUrl: string,
  className: string,
  methodName: string
): Promise<CompletionElementInfo | undefined> {
  try {
    // Construct a source snippet that references the method
    // The API will resolve the element at the cursor position
    const fakeSource = `${className}=>${methodName}( ).`
    const line = 1
    const column = className.length + 2 + methodName.length // Position at end of method name
    
    const result = await client.codeCompletionElement(sourceUrl, fakeSource, line, column)
    
    if (typeof result === "string") {
      return undefined
    }
    
    return result as CompletionElementInfo
  } catch (e) {
    return undefined
  }
}

/**
 * Try to get element info using codeCompletionElement API
 */
async function getElementInfo(
  client: any,
  sourceUrl: string,
  source: string,
  line: number,
  column: number
): Promise<CompletionElementInfo | undefined> {
  try {
    const result = await client.codeCompletionElement(sourceUrl, source, line, column)

    // The API might return a string (HTML) on older systems or CompletionElementInfo
    if (typeof result === "string") {
      return undefined
    }

    return result as CompletionElementInfo
  } catch (e) {
    return undefined
  }
}

/**
 * Try to get ABAP documentation for the element at cursor
 */
async function getAbapDocumentation(
  client: any,
  objectUri: string,
  source: string,
  line: number,
  column: number
): Promise<string | undefined> {
  try {
    const result = await client.abapDocumentation(objectUri, source, line, column)
    if (result && result.trim()) {
      return result
    }
    return undefined
  } catch (e) {
    return undefined
  }
}

function htmlToMarkdown(html: string): string {
  if (!html) return ""

  let md = html
    // Remove XML declaration
    .replace(/<\?xml[^>]*\?>/gi, "")
    // Remove head, script, and style blocks entirely
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")

  md = md
    // Convert headers
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n")
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n")
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n")
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n")
    // Convert spans with classes to formatting
    .replace(/<span[^>]*class="bold"[^>]*>(.*?)<\/span>/gi, "**$1**")
    .replace(/<span[^>]*class="italic"[^>]*>(.*?)<\/span>/gi, "*$1*")
    .replace(/<span[^>]*class="code"[^>]*>(.*?)<\/span>/gi, "`$1`")
    .replace(/<span[^>]*class="qtext"[^>]*>(.*?)<\/span>/gi, "`$1`")
    // Convert bold
    .replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**")
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
    // Convert italic
    .replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*")
    .replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*")
    // Convert code
    .replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
    .replace(/<pre[^>]*>(.*?)<\/pre>/gis, "```\n$1\n```")
    // Convert line breaks
    .replace(/<br\s*\/?>/gi, "\n")
    // Convert paragraphs
    .replace(/<p[^>]*>(.*?)<\/p>/gis, "$1\n\n")
    // Convert list items
    .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
    // Remove list containers
    .replace(/<\/?[ou]l[^>]*>/gi, "\n")
    // Convert tables (simple approach)
    .replace(/<tr[^>]*>/gi, "|")
    .replace(/<\/tr>/gi, "|\n")
    .replace(/<t[dh][^>]*>(.*?)<\/t[dh]>/gi, " $1 |")
    // Remove remaining HTML tags
    .replace(/<[^>]+>/g, "")
    // Decode HTML entities
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(parseInt(code, 10)))
    // Clean up extra whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return md
}

/**
 * Clean HTML for hover display by removing head/style but keeping body content
 */
function cleanHtmlForHover(html: string): string {
  if (!html) return ""

  let cleaned = html
    // Remove XML declaration
    .replace(/<\?xml[^>]*\?>/gi, "")
    // Remove doctype
    .replace(/<!doctype[^>]*>/gi, "")
    // Remove head, script, and style blocks entirely
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    // Remove html and body tags but keep content
    .replace(/<\/?html[^>]*>/gi, "")
    .replace(/<\/?body[^>]*>/gi, "")
    // Clean up extra whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim()

}

/**
 * Main hover handler
 */
export async function hoverHandler(
  params: TextDocumentPositionParams
): Promise<Hover | null> {
  const uri = params.textDocument.uri

  // Support both ABAP and CDS views
  if (!isAbap(uri) && !isCdsView(uri)) return null

  try {
    const co = await clientAndObjfromUrl(uri)
    if (!co) return null

    const { client, obj, source } = co
    const line = params.position.line + 1
    const column = params.position.character

    // Get the word at the current position for context
    const lines = source.split("\n")
    const currentLine = lines[params.position.line] || ""

    // Find word boundaries (include hyphen for table-field notation)
    let start = column
    let end = column
    while (start > 0 && /[\w<>\/-]/.test(currentLine[start - 1])) start--
    while (end < currentLine.length && /[\w<>\/-]/.test(currentLine[end])) end++
    const word = currentLine.substring(start, end)

    if (!word || word.length < 2) return null

    // For ABAP files, try the code completion element API first
    if (isAbap(uri)) {
      // Try to get element info from the code completion element API first
      // This works well for variables, parameters, and inline declarations
      const elementInfo = await getElementInfo(
        client.statelessClone,
        obj.mainUrl,
        source,
        line,
        column
      )

      if (elementInfo) {
        const content = await formatCompletionElement(elementInfo, client.statelessClone, source, obj.mainUrl)
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: content
          } as MarkupContent
        }
      }

      // Try ABAP documentation API - useful for methods, parameters, classes
      const abapDoc = await getAbapDocumentation(
        client.statelessClone,
        obj.mainUrl,
        source,
        line,
        column
      )

      if (abapDoc) {
        const content = htmlToMarkdown(abapDoc)
        if (content) {
          return {
            contents: {
              kind: MarkupKind.Markdown,
              value: content
            } as MarkupContent
          }
        }
      }
    }

    // For both ABAP and CDS, try DDIC element lookup for types
    // This handles inline type references like TYPE mara-matnr and CDS field types
    const upperWord = word.toUpperCase()

    // Check if this looks like a table-field reference (contains hyphen or dot)
    if (word.includes("-") || word.includes(".")) {
      const ddicPath = upperWord.replace(/-/g, ".")
      const ddicInfo = await getDdicElementInfo(client.statelessClone, ddicPath)
      if (ddicInfo) {
        const content = formatDdicElement(ddicInfo)
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: content
          } as MarkupContent
        }
      }
    }

    // For CDS views, also try looking up table/view elements directly
    if (isCdsView(uri)) {
      // Try to look up the word as a data source (table or view)
      const ddicInfo = await getDdicElementInfo(client.statelessClone, upperWord)
      if (ddicInfo) {
        const content = formatDdicElement(ddicInfo)
        return {
          contents: {
            kind: MarkupKind.Markdown,
            value: content
          } as MarkupContent
        }
      }
    }

    return null
  } catch (e) {
    return null
  }
}

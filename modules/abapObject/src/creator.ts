import { AbapObjectBase, AbapObjectConstructor, AbapObject } from "./AbapObject"
import { AbapObjectService } from "./AOService"
import { Node } from "abap-adt-api"
import { AbapObjectError } from "./AOError"
import { } from "./objectTypes"

const constructors = new Map<string, AbapObjectConstructor>()
export const AbapObjectCreator = (...types: string[]) => (
  target: AbapObjectConstructor
) => {
  for (const t of types) {
    if (constructors.has(t))
      throw new Error(`Conflict assigning constructor for type ${t}`)
    constructors.set(t, target)
  }
}

export const create = (
  type: string,
  name: string,
  path: string,
  expandable: boolean,
  techName: string,
  parent: AbapObject | undefined,
  sapguiUri: string,
  client: AbapObjectService,
  owner = ""
) => {
  if (!type || !path)
    throw new AbapObjectError(
      "Invalid",
      undefined,
      "Abap Object can't be created without a type and path"
    )
  // try several normalized forms to find a registered constructor
  const lookupCandidates = [
    type,
    type && type.replace(/\/.*/, ""),
    type && type.replace(/\//g, ""),
    type && type.toUpperCase(),
    type && (type.replace(/\/.*/, "")).toUpperCase()
  ]
  let cons: AbapObjectConstructor | undefined
  for (const c of lookupCandidates) {
    if (!c) continue
    cons = constructors.get(c)
    if (cons) break
  }
  if (!cons) cons = AbapObjectBase
  // debug information to help identify unmatched types
  try {
    // eslint-disable-next-line no-console
    console.log("AbapObject.create: type=", type, "-> constructor=", (cons as any).name)
  } catch (_) { }
  return new (cons as any)(
    type,
    name,
    path,
    expandable,
    techName,
    parent,
    sapguiUri,
    client,
    owner
  )
}

export const fromNode = (
  node: Node,
  parent: AbapObject | undefined,
  client: AbapObjectService
) =>
  create(
    node.OBJECT_TYPE,
    node.OBJECT_NAME,
    node.OBJECT_URI,
    !!node.EXPANDABLE,
    node.TECH_NAME,
    parent,
    node.OBJECT_VIT_URI,
    client
  )

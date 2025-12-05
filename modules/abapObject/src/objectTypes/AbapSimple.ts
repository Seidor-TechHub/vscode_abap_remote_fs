import {
  AbapObjectCreator,
  AbapObjectBase,
  AbapObject,
  AbapObjectService
} from ".."
const tag = Symbol("AbapSimple")

@AbapObjectCreator("TABL/DT", "TABL/DS", "SRFC", "TRAN/T", "PARA/R", "VIEW/DV")
export class AbapSimple extends AbapObjectBase {
  [tag] = true
  constructor(
    type: string,
    name: string,
    path: string,
    expandable: boolean,
    techName: string,
    parent: AbapObject | undefined,
    sapGuiUri: string,
    client: AbapObjectService
  ) {
    super(type, name, path, false, techName, parent, sapGuiUri, client)
  }
  get extension() {
    if (this.type === "TABL/DT") return ".tabl.abap"
    if (this.type === "TABL/DS") return ".stru.abap"
    if (this.type === "VIEW/DV") return ".view.xml"
    if (this.type === "TRAN/T") return ".tran.xml"
    return super.extension
  }
}

export const isAbapSimple = (x: any): x is AbapSimple => !!x?.[tag]

import { PDFDocument, degrees } from 'pdf-lib'
import { validatePagePlan } from './pagePlan.js'

export async function applyPagePlanToPdf(sourceBytes, plan) {
  const validation = validatePagePlan(plan)
  if (!validation.valid) throw new Error(validation.reason)

  const source = await PDFDocument.load(sourceBytes)
  const output = await PDFDocument.create()
  const firstPageSize = source.getPage(0).getSize()

  for (const item of plan) {
    let page
    if (item.isBlank) {
      page = output.addPage([firstPageSize.width, firstPageSize.height])
    } else {
      if (item.sourceIndex >= source.getPageCount()) {
        throw new Error(`Source page ${item.sourceIndex + 1} no longer exists.`)
      }
      ;[page] = await output.copyPages(source, [item.sourceIndex])
      output.addPage(page)
      if (item.rotationDelta) {
        const currentAngle = source.getPage(item.sourceIndex).getRotation().angle
        page.setRotation(degrees(((currentAngle + item.rotationDelta) % 360 + 360) % 360))
      }
    }
  }

  return new Uint8Array(await output.save({ useObjectStreams: true, addDefaultPage: false }))
}

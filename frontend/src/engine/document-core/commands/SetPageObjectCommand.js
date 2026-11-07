export class SetPageObjectCommand {
  constructor(object, { label = 'Update page object' } = {}) {
    this.object = structuredClone(object)
    this.label = label
    this.previousObject = undefined
    this.hadPrevious = false
  }

  async execute(core) {
    if (!this.hadPrevious) {
      this.previousObject = core.objects.get(this.object.id)
      this.hadPrevious = true
    }
    core.objects.upsert(this.object)
    core.notifyContentChange()
  }

  async undo(core) {
    if (this.previousObject) core.objects.upsert(this.previousObject)
    else core.objects.remove(this.object.id)
    core.notifyContentChange()
  }
}

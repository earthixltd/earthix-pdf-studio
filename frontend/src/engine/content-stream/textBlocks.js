const dot = (point, vector) => point.x * vector.x + point.y * vector.y

/**
 * True when a painted rule that is perpendicular to the text direction
 * (a table border or box edge) lies between `fromAlong` and `toAlong`.
 */
export function hasSeparatorBetween(rules, line, fromAlong, toAlong) {
  if (!rules?.length || toAlong - fromAlong < 0.5) return false
  const { direction, normal, baseline, size } = line
  const low = baseline - 0.1 * size
  const high = baseline + 0.6 * size
  for (const rule of rules) {
    const a1 = rule.x1 * direction.x + rule.y1 * direction.y
    const a2 = rule.x2 * direction.x + rule.y2 * direction.y
    if (Math.abs(a1 - a2) > 0.75) continue
    const along = (a1 + a2) / 2
    if (along <= fromAlong + 0.25 || along >= toAlong - 0.25) continue
    const c1 = rule.x1 * normal.x + rule.y1 * normal.y
    const c2 = rule.x2 * normal.x + rule.y2 * normal.y
    if (Math.min(c1, c2) <= high && Math.max(c1, c2) >= low) return true
  }
  return false
}

export function runAlong(run, direction) {
  return { start: dot(run.startPoint, direction), end: dot(run.endPoint, direction) }
}

export function runAngle(run) {
  return Math.round((Math.atan2(run.direction.y, run.direction.x) * 180) / Math.PI)
}

function styleKey(run) {
  return [
    run.fontKey,
    Math.round(run.fontSize * 100) / 100,
    Math.round(run.fontSizeUser * 10) / 10,
    Math.round(run.horizontalScaling),
    Math.round(run.characterSpacing * 1000) / 1000,
    run.fillColor,
    run.textRenderingMode,
  ].join('|')
}

/** Group text runs that share a direction and baseline into lines (sorted along the line). */
export function groupRunsIntoLines(runs) {
  const lines = []
  const ordered = [...runs].sort((a, b) => a.sequence - b.sequence)
  for (const run of ordered) {
    const angle = runAngle(run)
    const baseline = dot(run.startPoint, run.normal)
    const tolerance = Math.max(0.5, 0.3 * run.fontSizeUser)
    let line = lines.find((candidate) => Math.abs(candidate.angle - angle) <= 1 && Math.abs(candidate.baseline - baseline) <= Math.max(tolerance, 0.3 * candidate.fontSizeUser))
    if (!line) {
      line = { angle, baseline, direction: run.direction, normal: run.normal, fontSizeUser: run.fontSizeUser, runs: [] }
      lines.push(line)
    }
    line.runs.push(run)
  }
  for (const line of lines) {
    line.runs.sort((a, b) => dot(a.startPoint, line.direction) - dot(b.startPoint, line.direction) || a.sequence - b.sequence)
  }
  return lines
}

// Undecodable runs are kept (as locked blocks) so clicks on them can explain why.
const isVisibleTextRun = (run) => !run.invisible && run.glyphCount > 0 && run.fontSizeUser > 0.5

function buildCharMap(runs, direction, size) {
  const chars = []
  runs.forEach((run, runIndex) => {
    if (runIndex > 0) {
      const previous = runs[runIndex - 1]
      const gap = dot(run.startPoint, direction) - dot(previous.endPoint, direction)
      const lastChar = chars.at(-1)?.ch
      const firstGlyph = run.glyphs.find((glyph) => glyph.code !== undefined)
      if (gap > 0.18 * size && lastChar !== ' ' && firstGlyph?.unicode !== ' ') {
        chars.push({ ch: ' ', kind: 'gap', run: runIndex - 1, gap })
      }
    }
    run.glyphs.forEach((glyph, itemIndex) => {
      if (glyph.code !== undefined) {
        for (const ch of glyph.unicode) chars.push({ ch, kind: 'glyph', run: runIndex, item: itemIndex })
      } else if (glyph.virtualSpace) {
        chars.push({ ch: ' ', kind: 'adjust', run: runIndex, item: itemIndex })
      }
    })
  })
  return chars
}

function createBlock(pageIndex, line, runs) {
  const first = runs[0]
  const lastRun = runs.at(-1)
  const direction = line.direction
  const chars = buildCharMap(runs, direction, first.fontSizeUser)
  const bbox = [
    Math.min(...runs.map((run) => run.bbox[0])), Math.min(...runs.map((run) => run.bbox[1])),
    Math.max(...runs.map((run) => run.bbox[2])), Math.max(...runs.map((run) => run.bbox[3])),
  ]
  return {
    key: `${pageIndex}:b:${first.key}`,
    pageIndex,
    pageNumber: pageIndex + 1,
    text: chars.map((item) => item.ch).join(''),
    runKeys: runs.map((run) => run.key),
    chars,
    bbox,
    startPoint: first.startPoint,
    endPoint: lastRun.endPoint,
    direction: first.direction,
    normal: first.normal,
    angle: line.angle,
    fontSizeUser: first.fontSizeUser,
    fontKey: first.fontKey,
    fontResource: first.fontResource,
    fontSize: first.fontSize,
    fillColor: first.fillColor,
    strokeColor: first.strokeColor,
    textRenderingMode: first.textRenderingMode,
    decodable: runs.every((run) => run.decodable),
    horizontalScaling: first.horizontalScaling,
    characterSpacingUser: first.characterSpacing * first.scaleX * (first.horizontalScaling / 100),
    twinKeys: [],
  }
}

/**
 * Build editable text blocks for one page: consecutive runs on the same line,
 * with the same font/size/colour and only word-sized gaps between them.
 * Overprinted duplicates (shadow or fake-bold copies) are attached as twins so
 * an edit updates every copy instead of leaving a stale duplicate behind.
 */
export function buildTextBlocks(runs, pageIndex, rules = []) {
  const pageRuns = runs.filter((run) => run.pageIndex === pageIndex && isVisibleTextRun(run))
  const lines = groupRunsIntoLines(pageRuns)
  const blocks = []
  for (const line of lines) {
    let current = null
    let currentEnd = 0
    const lineBlocks = []
    for (const run of line.runs) {
      const along = runAlong(run, line.direction)
      const size = run.fontSizeUser
      const gap = current ? along.start - currentEnd : 0
      const separated = current && hasSeparatorBetween(rules, { direction: line.direction, normal: line.normal, baseline: dot(run.startPoint, line.normal), size }, currentEnd, along.start)
      const compatible = current && !separated && styleKey(current.at(-1)) === styleKey(run) && gap <= 1.0 * size && gap >= -0.3 * size
      if (compatible) {
        current.push(run)
        currentEnd = Math.max(currentEnd, along.end)
      } else {
        if (current) lineBlocks.push(current)
        current = [run]
        currentEnd = along.end
      }
    }
    if (current) lineBlocks.push(current)
    const built = lineBlocks.map((group) => createBlock(pageIndex, line, group))
    // Attach overprinted duplicates as twins of the first copy.
    const kept = []
    for (const block of built) {
      const start = dot(block.startPoint, line.direction)
      const twinOf = kept.find((candidate) => (
        candidate.text.replace(/\s+/g, '') === block.text.replace(/\s+/g, '') &&
        Math.abs(dot(candidate.startPoint, line.direction) - start) <= 0.3 * block.fontSizeUser &&
        Math.abs(dot(candidate.startPoint, line.normal) - dot(block.startPoint, line.normal)) <= 0.3 * block.fontSizeUser
      ))
      if (twinOf) twinOf.twins = [...(twinOf.twins || []), block]
      else kept.push(block)
    }
    for (const block of kept) {
      block.twinKeys = (block.twins || []).map((twin) => twin.key)
      block.twinBlocks = block.twins || []
      delete block.twins
      blocks.push(block)
    }
  }
  blocks.sort((a, b) => (b.bbox[3] - a.bbox[3]) || (a.bbox[0] - b.bbox[0]))
  return blocks
}

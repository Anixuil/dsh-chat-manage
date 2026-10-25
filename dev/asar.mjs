import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ASAR = process.argv[2]
const OUT = process.argv[3]
const buf = readFileSync(ASAR)

const headerSize = buf.readUInt32LE(12)
const headerString = buf.toString('utf8', 16, 16 + headerSize)
const header = JSON.parse(headerString)
const base = 16 + headerSize

function walk(node, prefix = '') {
  const out = []
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) out.push(...walk(entry, p))
    else out.push({ path: p, offset: entry.offset, size: entry.size })
  }
  return out
}

const entries = walk(header)
console.log('total files:', entries.length)

const filter = process.argv[4] ?? ''
const matched = entries.filter((e) => e.path.includes(filter))
console.log('matched:', matched.length)
for (const e of matched.slice(0, 400)) console.log(' -', e.path, e.size)

if (process.argv[5] === 'extract') {
  for (const e of matched) {
    const dest = join(OUT, e.path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, buf.subarray(base + Number(e.offset), base + Number(e.offset) + e.size))
  }
  console.log('extracted to', OUT)
}

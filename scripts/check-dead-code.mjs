import fs from 'node:fs'
import path from 'node:path'

const SOURCE_ROOT = path.resolve(process.cwd(), 'src')
const ENTRY_FILES = [
  path.resolve(SOURCE_ROOT, 'main.js'),
]

const SUPPORTED_EXTENSIONS = ['.js', '.mjs', '.vue']

function walkFiles(rootDir) {
  const files = []
  const stack = [rootDir]

  while (stack.length > 0) {
    const current = stack.pop()
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(nextPath)
        continue
      }

      const ext = path.extname(nextPath)
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        files.push(nextPath)
      }
    }
  }

  return files
}

function collectStaticImports(sourceCode) {
  const imports = []
  const fromRe = /\bimport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g

  let match
  while ((match = fromRe.exec(sourceCode)) !== null) {
    imports.push(match[1])
  }
  while ((match = bareRe.exec(sourceCode)) !== null) {
    imports.push(match[1])
  }

  return imports
}

function resolveImportPath(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null

  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base,
    ...SUPPORTED_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SUPPORTED_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }

  return null
}

function collectReachableFiles(entryFiles) {
  const reachable = new Set()
  const queue = [...entryFiles]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || reachable.has(current)) continue
    if (!fs.existsSync(current) || !fs.statSync(current).isFile()) continue

    reachable.add(current)
    const sourceCode = fs.readFileSync(current, 'utf8')
    const imports = collectStaticImports(sourceCode)

    for (const specifier of imports) {
      const resolved = resolveImportPath(current, specifier)
      if (resolved && !reachable.has(resolved)) {
        queue.push(resolved)
      }
    }
  }

  return reachable
}

function main() {
  const allSourceFiles = walkFiles(SOURCE_ROOT)
  const reachable = collectReachableFiles(ENTRY_FILES)

  const orphans = allSourceFiles
    .filter((filePath) => !ENTRY_FILES.includes(filePath))
    .filter((filePath) => !reachable.has(filePath))
    .map((filePath) => path.relative(process.cwd(), filePath))
    .sort()

  if (orphans.length > 0) {
    console.error('Dead code check failed. Unreachable source files:')
    for (const file of orphans) {
      console.error(`  - ${file}`)
    }
    process.exit(1)
  }

  console.log('Dead code check passed.')
}

main()

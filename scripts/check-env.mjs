import fs from 'node:fs'
import path from 'node:path'

const ALLOWED_ENV_KEYS = new Set([
  'MEDIATION_CONTROL_PLANE_API_BASE_URL',
  'MEDIATION_RUNTIME_API_BASE_URL',
  'MEDIATION_CONTROL_PLANE_API_PROXY_TARGET',
])

const REQUIRED_PRODUCTION_KEYS = [
  'MEDIATION_CONTROL_PLANE_API_BASE_URL',
]

const DEPRECATED_KEYS = new Set([
  'VITE_MEDIATION_CONTROL_PLANE_API_BASE_URL',
  'VITE_MEDIATION_RUNTIME_API_BASE_URL',
  'VITE_DASHBOARD_V1_MINIMAL',
  'VITE_ENABLE_INTERNAL_RESET',
])

function parseEnvKeys(content) {
  return String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => line.split('=')[0]?.trim())
    .filter(Boolean)
}

function readEnvFileKeys(filePath) {
  if (!fs.existsSync(filePath)) return []
  const content = fs.readFileSync(filePath, 'utf8')
  return parseEnvKeys(content)
}

function collectConfiguredEnvFiles(rootDir) {
  const defaults = [
    '.env',
    '.env.local',
    '.env.development',
    '.env.development.local',
    '.env.production',
    '.env.production.local',
    '.env.test',
    '.env.test.local',
  ]

  return defaults
    .map((name) => path.join(rootDir, name))
    .filter((target) => fs.existsSync(target))
}

function formatList(items) {
  return items.map((item) => `  - ${item}`).join('\n')
}

function hasArg(name) {
  return process.argv.slice(2).includes(name)
}

function main() {
  const rootDir = process.cwd()
  const errors = []

  const examplePath = path.join(rootDir, '.env.example')
  if (!fs.existsSync(examplePath)) {
    errors.push('.env.example is missing.')
  } else {
    const exampleKeys = readEnvFileKeys(examplePath)
    const unknownInExample = exampleKeys.filter((key) => !ALLOWED_ENV_KEYS.has(key))
    const missingRequired = REQUIRED_PRODUCTION_KEYS.filter((key) => !exampleKeys.includes(key))

    if (unknownInExample.length > 0) {
      errors.push(`Unknown keys in .env.example:\n${formatList(unknownInExample)}`)
    }
    if (missingRequired.length > 0) {
      errors.push(`Missing required production keys in .env.example:\n${formatList(missingRequired)}`)
    }
  }

  const configuredFiles = collectConfiguredEnvFiles(rootDir)
  for (const filePath of configuredFiles) {
    const fileKeys = readEnvFileKeys(filePath)
    const unknownKeys = fileKeys.filter((key) => !ALLOWED_ENV_KEYS.has(key))
    const deprecatedKeys = fileKeys.filter((key) => DEPRECATED_KEYS.has(key))

    if (unknownKeys.length > 0) {
      errors.push(`Unknown env keys in ${path.relative(rootDir, filePath)}:\n${formatList(unknownKeys)}`)
    }
    if (deprecatedKeys.length > 0) {
      errors.push(`Deprecated env keys found in ${path.relative(rootDir, filePath)}:\n${formatList(deprecatedKeys)}`)
    }
  }

  const strict = hasArg('--strict') || process.env.CHECK_ENV_STRICT === '1'
  if (strict) {
    const missingRuntimeKeys = REQUIRED_PRODUCTION_KEYS.filter((key) => !String(process.env[key] || '').trim())
    if (missingRuntimeKeys.length > 0) {
      errors.push(`Missing required runtime environment variables:\n${formatList(missingRuntimeKeys)}`)
    }
  }

  if (errors.length > 0) {
    console.error('Environment check failed:\n')
    console.error(errors.join('\n\n'))
    process.exit(1)
  }

  console.log('Environment check passed.')
}

main()

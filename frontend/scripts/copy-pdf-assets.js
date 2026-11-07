import { access, cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = path.resolve(frontendRoot, '..')
const publicRoot = path.join(frontendRoot, 'public')
const moduleRoots = [
  path.join(frontendRoot, 'node_modules'),
  path.join(projectRoot, 'node_modules'),
]

async function firstExistingPath(relativePath) {
  for (const moduleRoot of moduleRoots) {
    const candidate = path.join(moduleRoot, relativePath)
    try {
      await access(candidate)
      return candidate
    } catch {
      // Continue to the next npm workspace module location.
    }
  }
  return null
}

async function copyPackageAsset(packagePath, assetPath, destinationPath, { required = false } = {}) {
  const source = await firstExistingPath(path.join(packagePath, assetPath))
  if (!source) {
    const message = `PDF asset not found: ${packagePath}/${assetPath}. Run npm install from the project root.`
    if (required) throw new Error(message)
    process.stderr.write(`Optional ${message}\n`)
    return false
  }

  const destination = path.join(publicRoot, destinationPath)
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, force: true })
  process.stdout.write(`Prepared ${destinationPath}\n`)
  return true
}

// pdfjs-dist@6.5.438 keeps worker files in build/ and auxiliary assets at package root.
await Promise.all([
  copyPackageAsset('pdfjs-dist', 'build/pdf.worker.mjs', 'pdfjs/pdf.worker.mjs', { required: true }),
  copyPackageAsset('pdfjs-dist', 'cmaps', 'pdfjs/cmaps', { required: true }),
  copyPackageAsset('pdfjs-dist', 'standard_fonts', 'pdfjs/standard_fonts', { required: true }),
  copyPackageAsset('pdfjs-dist', 'wasm', 'pdfjs/wasm', { required: true }),
  copyPackageAsset('pdfjs-dist', 'image_decoders', 'image_decoders', { required: true }),
  copyPackageAsset('pdfjs-dist', 'iccs', 'pdfjs/iccs', { required: true }),
  copyPackageAsset('@embedpdf/pdfium', 'dist/pdfium.wasm', 'pdfium/pdfium.wasm', { required: true }),
])

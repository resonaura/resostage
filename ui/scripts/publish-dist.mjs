import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const uiDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stagingDirectory = join(uiDirectory, '.dist-staging')
const outputDirectory = join(uiDirectory, 'dist')

function copyPublishedAssets(sourceDirectory, targetDirectory, isRoot = false) {
  mkdirSync(targetDirectory, { recursive: true })
  for (const entry of readdirSync(sourceDirectory)) {
    // Publish the new entry point last. Content-hashed assets from older builds
    // stay in dist so a window holding an older HTML document can finish loading.
    if (isRoot && entry === 'index.html') continue
    const source = join(sourceDirectory, entry)
    const target = join(targetDirectory, entry)
    if (statSync(source).isDirectory()) copyPublishedAssets(source, target)
    else copyFileSync(source, target)
  }
}

const stagedIndex = join(stagingDirectory, 'index.html')
const publishedIndex = join(outputDirectory, 'index.html')
const temporaryIndex = join(outputDirectory, `.index-${process.pid}.tmp`)

copyPublishedAssets(stagingDirectory, outputDirectory, true)
writeFileSync(temporaryIndex, readFileSync(stagedIndex))
renameSync(temporaryIndex, publishedIndex)

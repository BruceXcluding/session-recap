// Builds the dsh package: copies the session reader and the recap core into
// packages/dsh/vendor (a package installed into a dsh profile cannot reach
// files outside itself), then, with --pack, packs the release tarball into
// dist/. Run: node scripts/build-dsh.mjs [--pack]
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = join(root, 'packages', 'dsh')
const vendor = join(pkg, 'vendor')

rmSync(vendor, { recursive: true, force: true })
mkdirSync(join(vendor, 'core'), { recursive: true })
copyFileSync(join(root, 'hooks', 'digest.py'), join(vendor, 'digest.py'))
for (const f of readdirSync(join(root, 'core'))) copyFileSync(join(root, 'core', f), join(vendor, 'core', f))
copyFileSync(join(root, 'LICENSE'), join(pkg, 'LICENSE'))

if (process.argv.includes('--pack')) {
  const dist = join(root, 'dist')
  mkdirSync(dist, { recursive: true })
  const out = execFileSync('npm', ['pack', '--pack-destination', dist], { cwd: pkg, encoding: 'utf8' })
  const packed = join(dist, out.trim().split('\n').at(-1))
  // The same tarball under a name without the version: the dsh-market listing
  // installs releases/latest/download/dsh-session-recap.tgz, so every release
  // must carry it.
  const latest = join(dist, 'dsh-session-recap.tgz')
  copyFileSync(packed, latest)
  process.stdout.write(`packed ${packed}\nand ${latest}\n`)
} else {
  process.stdout.write(`vendored into ${vendor}\n`)
}

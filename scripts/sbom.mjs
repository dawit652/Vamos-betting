#!/usr/bin/env node
/**
 * Writes a CycloneDX 1.5 software bill of materials (JSON) of the production
 * dependencies of every workspace package to stdout (ASVS 14.2.5):
 *
 *   pnpm sbom > sbom.cdx.json
 *
 * Built from `pnpm licenses list --prod --json` (the installed, lockfile-pinned
 * packages with their versions and licences); CI keeps the file as a build
 * artifact. Run it after `pnpm install`.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const listing = JSON.parse(
  execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);

/** A package URL (purl) of an npm package: the scope's @ is percent-encoded. */
function purl(name, version) {
  return `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;
}

/** The CycloneDX licence entry of an SPDX id, expression or free text. */
function licenseOf(license) {
  if (license === undefined || license === '' || license === 'Unknown') return [];
  if (/\s(AND|OR|WITH)\s|[()]/.test(license)) return [{ expression: license }];
  if (/^[A-Za-z0-9.+-]+$/.test(license)) return [{ license: { id: license } }];
  return [{ license: { name: license } }];
}

const components = [];
for (const [license, packages] of Object.entries(listing)) {
  for (const pkg of packages) {
    for (const version of pkg.versions) {
      components.push({
        type: 'library',
        'bom-ref': purl(pkg.name, version),
        name: pkg.name,
        version,
        purl: purl(pkg.name, version),
        licenses: licenseOf(pkg.license ?? license),
        ...(pkg.homepage ? { externalReferences: [{ type: 'website', url: pkg.homepage }] } : {}),
      });
    }
  }
}
components.sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'vamos scripts/sbom.mjs' }] },
    component: { type: 'application', name: root.name, 'bom-ref': root.name },
  },
  components,
};
process.stdout.write(`${JSON.stringify(bom, null, 2)}\n`);

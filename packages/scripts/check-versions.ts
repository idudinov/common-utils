/* eslint-disable no-console */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type PackageMeta = { dir: string; name: string; version: string };

const BASE_REF = process.env.BASE_REF ?? 'origin/main';

function readPackages(repoRoot: string): PackageMeta[] {
    const packagesDir = path.join(repoRoot, 'packages');
    return fs.readdirSync(packagesDir)
        .map((dir) => ({ dir, file: path.join(packagesDir, dir, 'package.json') }))
        .filter(({ file }) => fs.existsSync(file))
        .map(({ dir, file }) => ({ dir, ...JSON.parse(fs.readFileSync(file, 'utf8')) }))
        .filter((meta) => !meta.private && meta.name && meta.version)
        .map(({ dir, name, version }) => ({ dir, name, version }));
}

/** Version at BASE_REF, or null if the file/ref is absent (new package). */
function baseVersion(dir: string): string | null {
    try {
        const raw = execFileSync('git', ['show', `${BASE_REF}:packages/${dir}/package.json`], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        return JSON.parse(raw).version ?? null;
    } catch {
        return null;
    }
}

function sourceChanged(dir: string): boolean {
    try {
        const out = execFileSync('git', ['diff', '--name-only', `${BASE_REF}...HEAD`, '--', `packages/${dir}`], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.trim().length > 0;
    } catch {
        return false;
    }
}

/** Every version number the registry will refuse to accept again. */
async function burnedVersions(name: string): Promise<Set<string> | null> {
    const registry = (process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/$/, '');
    const res = await fetch(`${registry}/${name.replace('/', '%2f')}`);
    if (res.status === 404) {
        return null; // package has never existed
    }
    if (!res.ok) {
        throw new Error(`registry lookup failed for ${name}: ${res.status} ${res.statusText}`);
    }
    const doc = await res.json() as {
        versions?: Record<string, unknown>;
        time?: Record<string, unknown>;
    };
    const burned = new Set(Object.keys(doc.versions ?? {}));
    for (const key of Object.keys(doc.time ?? {})) {
        // `time` retains unpublished versions, which npm burns permanently.
        if (key !== 'created' && key !== 'modified' && key !== 'unpublished') {
            burned.add(key);
        }
    }
    return burned;
}

/** Locates the `"version"` key so annotations point at the line you'd edit. */
function versionLocation(dir: string): { file: string; line: number; col: number; endColumn: number } {
    const file = `packages/${dir}/package.json`;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const line = lines.findIndex((l) => l.includes('"version"'));
    if (line < 0) {
        return { file, line: 1, col: 1, endColumn: 1 };
    }
    const col = lines[line].indexOf('"version"') + 1;
    return { file, line: line + 1, col, endColumn: col + lines[line].trim().length };
}

/** GitHub workflow command; renders inline in the PR when the line is part of the diff. */
function annotate(level: 'warning' | 'error', dir: string, title: string, message: string) {
    if (!process.env.GITHUB_ACTIONS) {
        console[level === 'error' ? 'error' : 'warn'](`${level === 'error' ? 'x' : '!'} ${message}`);
        return;
    }
    const { file, line, col, endColumn } = versionLocation(dir);
    console.log(`::${level} file=${file},line=${line},col=${col},endColumn=${endColumn},title=${title}::${message}`);
}

/** Appends to the job summary, which renders even when a line is outside the diff. */
function summarize(lines: string[]) {
    const target = process.env.GITHUB_STEP_SUMMARY;
    if (target && lines.length > 0) {
        fs.appendFileSync(target, lines.join('\n') + '\n');
    }
}

export async function checkVersions({ all = false }: { all?: boolean } = {}) {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    const packages = readPackages(repoRoot);

    const errors: string[] = [];
    const warnings: string[] = [];

    for (const { dir, name, version } of packages) {
        const base = baseVersion(dir);
        const bumped = all || base === null || base !== version;

        if (!bumped) {
            if (sourceChanged(dir)) {
                const message = `${name}: source changed but version stayed at ${version}. Bump it if this should be released.`;
                annotate('warning', dir, 'Unreleased changes', message);
                warnings.push(message);
            } else {
                console.log(`- ${name}@${version} unchanged vs ${BASE_REF}, skipped`);
            }
            continue;
        }

        const burned = await burnedVersions(name);
        if (burned === null) {
            console.log(`+ ${name}@${version} new package, available`);
        } else if (burned.has(version)) {
            const message = `${name}@${version} is already taken on the registry (published or unpublished — npm will reject it). Bump to an unused version.`;
            annotate('error', dir, 'Version already published', message);
            errors.push(message);
        } else {
            console.log(`+ ${name}@${version} available`);
        }
    }

    summarize([
        ...(errors.length > 0 ? ['### Version check failed', ...errors.map((e) => `- ${e}`)] : []),
        ...(warnings.length > 0 ? ['### Unreleased changes', ...warnings.map((w) => `- ${w}`)] : []),
    ]);

    if (errors.length > 0) {
        console.error('\nBump the affected package version(s) before merging.');
        process.exitCode = 1;
        return;
    }

    console.log('\nAll released versions are available.');
}

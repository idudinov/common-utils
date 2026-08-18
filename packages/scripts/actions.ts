import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { generateExports } from './generate-exports.ts';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/** Copies LICENSE/package.json/README.md into dist/ and regenerates dist/package.json exports. */
function bundle() {
    const cwd = process.cwd();
    const dist = path.join(cwd, 'dist');
    fs.mkdirSync(dist, { recursive: true });

    for (const file of [path.join(repoRoot, 'LICENSE'), path.join(cwd, 'package.json'), path.join(cwd, 'README.md')]) {
        fs.copyFileSync(file, path.join(dist, path.basename(file)));
    }

    generateExports({ cwd, srcMode: false });
}

function updateExports() {
    generateExports({ cwd: process.cwd(), srcMode: true, verbose: true });
}

/** In-process task implementations that aren't a single external binary invocation. */
export const ACTIONS: Record<string, () => void> = {
    bundle,
    'update-exports': updateExports,
};

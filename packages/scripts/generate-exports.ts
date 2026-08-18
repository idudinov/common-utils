/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const FOLDER_IGNORE_PATTERNS = [/__tests__/, /node_modules/];

const fileExists = (filePath: string) => fs.existsSync(filePath);

const SrcExport = (p: string) => `./src/${p}/index.ts`;

function getExports(relativePath: string) {
    return {
        types: `./${relativePath}/index.d.ts`,
        default: `./${relativePath}/index.js`,
    };
}

/**
 * Regenerates the `exports` map of a package.json, either for source (`--src`)
 * or for the built `dist/` output.
 */
export type GenerateExportsOptions = {
    cwd?: string;
    srcMode?: boolean;
    verbose?: boolean;
};

export function generateExports({ cwd = process.cwd(), srcMode = false, verbose = false }: GenerateExportsOptions = {}) {
    const SRC_DIR = path.resolve(cwd, 'src');
    const PACKAGE_JSON_PATH = path.resolve(cwd, srcMode ? 'package.json' : 'dist/package.json');

    console.log('Updating package.json with exports', srcMode ? 'for src' : 'for dist');

    const packageJson: any = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

    if (!srcMode) {
        packageJson.exports = {
            './*': {
                types: './*.d.ts',
                default: './*.js',
            },
        };

        delete packageJson.devDependencies;
        delete packageJson.scripts;
        delete packageJson.config;
    } else {
        packageJson.exports = {
            './*': './src/*.ts',
        };
    }

    const processDirectory = (currentPath: string, parentFolder: string) => {
        const folders = fs.readdirSync(currentPath, { withFileTypes: true });
        folders.forEach((folder) => {
            if (!folder.isDirectory()) {
                return;
            }

            if (FOLDER_IGNORE_PATTERNS.some((pattern) => folder.name.match(pattern))) {
                if (verbose) {
                    console.log('--- Ignoring folder:', folder.name);
                }
                return;
            }

            const folderPath = path.join(currentPath, folder.name);
            const indexTsPath = path.join(folderPath, 'index.ts');
            const indexJsPath = path.join(folderPath, 'index.js');

            const relativePath = parentFolder
                ? (parentFolder + '/' + folder.name)
                : folder.name;

            if (fileExists(indexTsPath) || fileExists(indexJsPath)) {
                packageJson.exports[`./${relativePath}`] = srcMode ? SrcExport(relativePath) : getExports(relativePath);
            } else if (verbose) {
                console.log('--- No index.ts/.js found in', currentPath, '=>', relativePath);
            }

            processDirectory(folderPath, relativePath);
        });
    };

    processDirectory(SRC_DIR, '');

    fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
    console.log('package.json updated successfully with exports.');
}

// Thin CLI entry, kept for direct invocation: node generate-exports.ts [--src] [--verbose]
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));
if (isMain) {
    generateExports({
        srcMode: process.argv.includes('--src'),
        verbose: process.argv.includes('--verbose'),
    });
}

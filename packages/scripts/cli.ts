#!/usr/bin/env node
/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { ACTIONS } from './actions.ts';

type StepObject = { cmd: string; cwd?: string };
type Step = string | StepObject;

type TasksConfig = {
    commands: Record<string, string>;
    aliases: Record<string, string>;
    composites: Record<string, Step[]>;
};

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const binDir = path.join(repoRoot, 'node_modules', '.bin');

const { commands, aliases, composites }: TasksConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf8'),
);

/** Splits a command string into argv tokens, honoring single/double-quoted segments. */
function tokenize(command: string): string[] {
    const tokens: string[] = [];
    const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(command)) !== null) {
        tokens.push(match[1] ?? match[2] ?? match[3]);
    }
    return tokens;
}

function resolveBin(name: string): string {
    const candidates = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
    for (const candidate of candidates) {
        const candidatePath = path.join(binDir, candidate);
        if (fs.existsSync(candidatePath)) {
            return candidatePath;
        }
    }
    return name;
}

function spawnCommand(command: string, { cwd, extraArgs = [] }: { cwd?: string; extraArgs?: string[] } = {}): number {
    const [bin, ...args] = tokenize(command);
    const resolvedCwd = cwd ? path.resolve(process.cwd(), cwd) : process.cwd();
    const result = spawnSync(resolveBin(bin), [...args, ...extraArgs], {
        stdio: 'inherit',
        cwd: resolvedCwd,
        shell: process.platform === 'win32',
    });
    if (result.error) {
        console.error(result.error);
        return 1;
    }
    return result.status ?? 1;
}

function isKnownTaskName(name: string): boolean {
    return !/\s/.test(name) && (name in commands || name in ACTIONS || name in composites || name in aliases);
}

async function runStep(step: Step): Promise<number> {
    if (typeof step === 'string') {
        return isKnownTaskName(step) ? runTask(step) : spawnCommand(step);
    }
    return spawnCommand(step.cmd, { cwd: step.cwd });
}

async function runSequence(steps: Step[]): Promise<number> {
    for (const step of steps) {
        const code = await runStep(step);
        if (code !== 0) {
            return code;
        }
    }
    return 0;
}

async function runTask(name: string, extraArgs: string[] = []): Promise<number> {
    const resolvedName = aliases[name] ?? name;

    if (ACTIONS[resolvedName]) {
        await ACTIONS[resolvedName]();
        return Number(process.exitCode ?? 0);
    }

    if (commands[resolvedName]) {
        return spawnCommand(commands[resolvedName], { extraArgs });
    }

    if (composites[resolvedName]) {
        return runSequence(composites[resolvedName]);
    }

    console.error(`task: unknown task "${name}"`);
    return 1;
}

const [, , taskName, ...extraArgs] = process.argv;

if (!taskName) {
    console.error('task: missing task name');
    process.exit(1);
}

process.exit(await runTask(taskName, extraArgs));

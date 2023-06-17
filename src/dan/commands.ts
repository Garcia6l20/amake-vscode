import * as vscode from "vscode";
import { channelExec, handleDiagnostics, streamExec } from "./run";
import { Dan } from "../extension";
import { isTarget, Target } from "./targets";
import { TestSuiteInfo, TestInfo } from "./testAdapter";
import { DebuggerEnvironmentVariable } from "./debugger";

export async function scanToolchains(ext: Dan) {
    let args = [];
    if (ext.getConfig<boolean>('verbose')) {
        args.push('-v');
    }
    return channelExec('scan-toolchains');
}

const danBaseArgs = ['python', '-m', 'dan'];
const codeInterfaceArgs = [...danBaseArgs, 'code'];

export async function codeCommand<T>(ext: Dan, fn: string, ...args: string[]): Promise<T> {
    let stream = streamExec([...codeInterfaceArgs, fn, ...args], {
        env: {
            ...process.env,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'DAN_BUILD_PATH': ext.buildPath,
        },
        cwd: ext.projectRoot,
    });
    let data = '';
    stream.onLine((line: string, isError) => {
        if (!handleDiagnostics(line, ext.buildDiagnosics)) {
            data += line;
        }
    });
    let rc = await stream.finished();
    if (rc !== 0) {
        throw Error(`dan: ${fn} failed: ${data}`);
    } else {
        try {
            return JSON.parse(data) as T;
        } catch (e) {
            throw Error(`dan: ${fn} failed to parse output: ${data}`);
        }
    }
}

export async function getToolchains(ext: Dan): Promise<string[]> {
    return codeCommand<string[]>(ext, 'get-toolchains');
}

export async function getTargets(ext: Dan): Promise<Target[]> {
    return codeCommand<Target[]>(ext, 'get-targets');
}


export async function getTests(ext: Dan): Promise<string[]> {
    return codeCommand<string[]>(ext, 'get-tests');
}

export async function getTestSuites(ext: Dan): Promise<TestSuiteInfo> {
    return codeCommand<TestSuiteInfo>(ext, 'get-test-suites');
}

export async function configure(ext: Dan) {
    let args = ['-B', ext.buildPath, '-S', ext.projectRoot];
    const settings = ext.getConfig<Object>('settings');
    if (settings !== undefined) {
        for (const [key, value] of Object.entries(settings)) {
            args.push('-s', `${key}=${value}`);
        }
    }
    const options = ext.getConfig<Object>('options');
    if (options !== undefined) {
        for (const [key, value] of Object.entries(options)) {
            args.push('-o', `${key}=${value}`);
        }
    }
    if (ext.getConfig<boolean>('verbose')) {
        args.push('-v');
    }
    args.push('--toolchain');
    args.push(await vscode.window.showQuickPick(['default', ...ext.toolchains]) ?? 'default');
    return channelExec('configure', args, null, true, ext.projectRoot);
}

function baseArgs(ext: Dan): string[] {
    let args = ['-B', ext.buildPath];
    if (ext.getConfig<boolean>('verbose')) {
        args.push('-v');
    }
    const jobs = ext.getConfig<number>('jobs');
    if (jobs !== undefined) {
        args.push('-j', jobs.toString());
    }
    return args;
}

interface PythonDebugConfiguration {
    type: string;
    name: string;
    request: string;
    program?: string;
    module?: string;
    justMyCode?: boolean;
    args?: string[];
    cwd?: string;
    environment?: DebuggerEnvironmentVariable[];
}

export async function build(ext: Dan, targets: Target[] | string[] = [], debug = false) {
    let args = baseArgs(ext);
    if (targets.length !== 0) {
        args.push(...targets.map((t) => {
            if (isTarget(t)) {
                return t.fullname;
            } else {
                return t;
            }
        }));
    }
    if (debug) {
        const cfg: PythonDebugConfiguration = {
            name: 'dan build',
            type: 'python',
            request: 'launch',
            module: 'dan',
            justMyCode: ext.getConfig<boolean>('pythonDebugJustMyCode'),
            args: ['build', ...args],
            cwd: ext.projectRoot
        };
        await vscode.debug.startDebugging(undefined, cfg);
    } else {
        await channelExec('code', ['build', ...args], null, true, ext.projectRoot, ext.buildDiagnosics);
    }
}

export async function clean(ext: Dan) {
    return channelExec('clean', [...baseArgs(ext), ...ext.buildTargets.map(t => t.fullname)], null, true, ext.projectRoot);
}

export async function run(ext: Dan) {
    let args = baseArgs(ext);
    if (ext.launchTarget) {
        args.push(ext.launchTarget.fullname);
    }
    return channelExec('run', args, null, true, ext.projectRoot);
}

export async function test(ext: Dan) {
    let args = baseArgs(ext);
    args.push(...ext.tests);
    return channelExec('test', args, null, true, ext.projectRoot);
}

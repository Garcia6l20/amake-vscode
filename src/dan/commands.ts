import * as vscode from "vscode";
import { channelExec, handleDiagnostics, Stream } from "./run";
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

const danBaseArgs = ['-m', 'dan'];
const codeInterfaceArgs = [...danBaseArgs, 'code'];

export async function codeCommand<T>(ext: Dan, fn: string, ...args: string[]): Promise<T> {
    let stream = new Stream('python', [...codeInterfaceArgs, fn, ...args], {
        env: {
            ...process.env,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'DAN_BUILD_PATH': ext.buildPath,
        },
        cwd: ext.projectRoot,
    });
    let data = '';
    stream.onLine((line: string, isError: boolean) => {
        if (!handleDiagnostics(line, ext.buildDiagnosics)) {
            data += line;
        }
    });
    let rc = await stream.finished();
    if (rc !== 0) {
        const msg = `dan: ${fn} failed: ${data}`;
        console.error(msg);
        throw Error(msg);
    } else {
        try {
            return JSON.parse(data) as T;
        } catch (e) {
            const msg = `dan: ${fn} failed to parse output: ${data}`;
            console.error(msg);
            throw Error(msg);
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
    const toolchain = await ext.currentToolchain();
    if (toolchain === undefined) {
        return;
    }
    let args = ['-B', ext.buildPath, '-S', ext.projectRoot];
    const settings = ext.getConfig<Object>('settings');
    if (settings !== undefined) {
        for (const [key, value] of Object.entries(settings)) {
            args.push('-s', `${key}=${value}`);
        }
    }
    args.push('-s', `build_type=${ext.buildType}`);
    const options = ext.getConfig<Object>('options');
    if (options !== undefined) {
        for (const [key, value] of Object.entries(options)) {
            args.push('-o', `${key}=${value}`);
        }
    }
    if (ext.getConfig<boolean>('verbose')) {
        args.push('-v');
    }
    args.push('--toolchain', toolchain);
    return channelExec('configure', args, undefined, true, ext.projectRoot);
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
        await channelExec('code', ['build', ...args], undefined, true, ext.projectRoot, ext.buildDiagnosics);
    }
}

export async function clean(ext: Dan) {
    return channelExec('clean', [...baseArgs(ext), ...ext.buildTargets.map(t => t.fullname)], undefined, true, ext.projectRoot);
}

export async function run(ext: Dan) {
    let args = baseArgs(ext);
    if (ext.launchTarget) {
        args.push(ext.launchTarget.fullname);
    }
    return channelExec('run', args, undefined, true, ext.projectRoot);
}

export async function test(ext: Dan) {
    let args = baseArgs(ext);
    args.push(...ext.tests);
    return channelExec('test', args, undefined, true, ext.projectRoot);
}

import * as vscode from "vscode";
import * as cp from "child_process";
import * as sq from 'shell-quote';

export function str2cmdline(str: string, env?: { readonly [key: string]: string | undefined }): Array<string> {
    return sq.parse(str, env).map((e) => e.toString());
};

function processBuffer(data: any, isError: boolean, fn: (line: string, isError: boolean) => void) {
    for (let line of data.toString().split(/\r?\n|\r/)) {
        line = line.trim();
        if (line.length > 0) {
            fn(line, isError);
        }
    }
}

export class Stream {
    private proc: cp.ChildProcess;

    constructor(command: string, args: string[], options: cp.SpawnOptions = {}) {
        this.proc = cp.spawn(command, args, options);
    }

    onLine(fn: (line: string, isError: boolean) => void) {
        this.proc.stdout?.on("data", (chunk: any) => processBuffer(chunk, false, fn));
        this.proc.stderr?.on("data", (chunk: any) => processBuffer(chunk, true, fn));
    }
    kill(signal?: NodeJS.Signals) {
        this.proc.kill(signal || "SIGTERM");
    }
    private _onExit(code: number | null): number {
        if (code === null) {
            if (this.proc.killed) {
                return -1;
            } else {
                return 0;
            }
        }
        return code;
    }
    finished() {
        return new Promise<number>(res => {
            this.proc.on("exit", (code) => {
                code = this._onExit(code);
                res(code);
            });
        });
    }
}

let _channel: vscode.LogOutputChannel;
function getOutputChannel(): vscode.LogOutputChannel {
    if (!_channel) {
        _channel = vscode.window.createOutputChannel("dan", { log: true });
    }
    return _channel;
}

function getLogLevel(): vscode.LogLevel {
    return getOutputChannel().logLevel;
}

export function getLogArgs(): string[] {
    switch (getLogLevel()) {
        case vscode.LogLevel.Trace:
            return ['-vv'];
        case vscode.LogLevel.Debug:
            return ['-v'];
        default:
            return [];
    }
}

export function handleDiagnostics(line: string, diagnostics: vscode.DiagnosticCollection | undefined): boolean {
    if (diagnostics !== undefined) {
        const diagmatch = /DIAGNOSTICS: (.+)$/g.exec(line.trim());
        if (diagmatch) {
            const data = JSON.parse(diagmatch[1]);
            for (const fname in data) {
                const diag = data[fname];
                diagnostics.set(vscode.Uri.file(fname), diag);
            }
            return true;
        }
    }
    return false;
}

class LogStream {
    readonly _expr = /\[([\d:.]+)\]\[(\w+)\]\s*(.+?):\s*(.+)/;

    constructor(readonly output: vscode.LogOutputChannel) {
    }

    processLine(line: string) {
        const m = this._expr.exec(line);
        if (m) {
            let out = this.output.info;
            switch (m[2]) {
                case 'DEBUG':
                    out = this.output.debug;
                    break;
                case 'WARNING':
                    out = this.output.warn;
                    break;
                case 'ERROR':
                case 'CRITICAL':
                    out = this.output.error;
                    break;
            }
            out(`${m[3]}: ${m[4]}`);
        } else {
            this.output.appendLine(line);
        }
    }
};

export function channelExec(command: string,
    parameters: string[] = [],
    title: string | undefined = undefined,
    cancellable: boolean = true,
    cwd: string | undefined = undefined,
    diagnostics: vscode.DiagnosticCollection | undefined = undefined) {
    const commandName = command === 'code' ? parameters[0] : command;
    let stream = new Stream('python', ['-m', 'dan', command, ...parameters], { cwd: cwd });
    title = title ?? `Executing ${commandName} ${parameters.join(' ')}`;
    const channel = getOutputChannel();
    channel.clear();
    channel.show();
    channel.info('executing:', commandName);
    channel.trace('command args:', ...parameters);
    diagnostics?.clear();
    return new Promise<void>((resolve, reject) => {
        vscode.window.withProgress(
            {
                title: title,
                location: vscode.ProgressLocation.Notification,
                cancellable: cancellable,
            },
            async (progress, token) => {
                token.onCancellationRequested(() => stream.kill());
                let oldPercentage = 0;
                progress.report({ message: 'running...', increment: 0 });
                const barExpr = /(.+):\s+(\d+)%\|/;
                const logStream = new LogStream(channel);
                stream.onLine((line: string, isError) => {
                    const barmatch = barExpr.exec(line);
                    if (barmatch) {
                        const percentage = parseInt(barmatch[2]);
                        const increment = percentage - oldPercentage;
                        oldPercentage = percentage;
                        if (increment > 0) {
                            progress.report({ increment: increment, message: barmatch[1] });
                        }
                    } else if (!handleDiagnostics(line, diagnostics)) {
                        logStream.processLine(line);
                    }
                });
                const rc = await stream.finished();
                const statusStr = rc === 0 ? 'succeed' : 'failed';
                progress.report({ increment: 100 - oldPercentage, message: statusStr });
                if (rc !== 0) {
                    channel.error(`command: ${commandName} failed`);
                    vscode.window.showErrorMessage(`dan: ${commandName} ${statusStr}: see output log`);
                    channel.show();
                    reject();
                } else {
                    channel.info(`command: ${commandName} succeed`);
                    resolve();
                }
            }
        );
    });
}

function getTerminal(): vscode.Terminal {
    let terminal = vscode.window.terminals.find(t => t.name === 'dan') ?? null;
    if (!terminal) {
        terminal = vscode.window.createTerminal("dan");
    }
    terminal.show();
    return terminal;
}


export function termExec(command: string,
    parameters: string[] = [],
    title: string | null = null,
    cancellable: boolean = true,
    cwd: string | undefined = undefined) {
    let term = getTerminal();
    term.show();
    let args = ['python', '-m', 'dan', command, ...parameters];
    if (cwd) {
        args.unshift('cd', cwd, '&&');
    }
    term.sendText(args.join(' '));
}

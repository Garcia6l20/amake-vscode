import * as vscode from "vscode";
import * as cp from "child_process";

function  processBuffer(data: Buffer, isError: boolean, fn: (line: string, isError: boolean) => void) {
    for (const line of data.toString().split(/\r?\n/)) {
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
        this.proc.stdout?.on("data", (data: Buffer) => processBuffer(data, false, fn));
        this.proc.stderr?.on("data", (data: Buffer) => processBuffer(data, true, fn));
    }
    kill(signal?: NodeJS.Signals) {
        this.proc.kill(signal || "SIGTERM");
    }
    private _onExit(code: number|null): number {
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

let _channel: vscode.OutputChannel;
function getOutputChannel(): vscode.OutputChannel {
    if (!_channel) {
        _channel = vscode.window.createOutputChannel("dan");
    }
    return _channel;
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

export function channelExec(command: string,
    parameters: string[] = [],
    title: string | null = null,
    cancellable: boolean = true,
    cwd: string | undefined = undefined,
    diagnostics: vscode.DiagnosticCollection | undefined = undefined) {
    let stream = new Stream('python', ['-m', 'dan', command, ...parameters], { cwd: cwd });
    title = title ?? `Executing ${command} ${parameters.join(' ')}`;
    const channel = getOutputChannel();
    channel.clear();
    channel.show();
    diagnostics?.clear();
    return vscode.window.withProgress(
        {
            title: title,
            location: vscode.ProgressLocation.Notification,
            cancellable: cancellable,
        },
        async (progress, token) => {
            token.onCancellationRequested(() => stream.kill());
            let oldPercentage = 0;
            progress.report({ message: 'running...', increment: 0 });
            stream.onLine((line: string, isError) => {
                const barmatch = /(.+):\s+(\d+)%\|/g.exec(line);
                if (barmatch) {
                    const percentage = parseInt(barmatch[2]);
                    const increment = percentage - oldPercentage;
                    oldPercentage = percentage;
                    if (increment > 0) {
                        progress.report({ increment: increment, message: barmatch[1] });
                    }
                } else if (!handleDiagnostics(line, diagnostics)) {
                    channel.appendLine(line);
                }
            });
            await stream.finished();
            progress.report({ increment: 100 - oldPercentage, message: 'done' });
            channel.appendLine(`${command} done`);
        }
    );
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

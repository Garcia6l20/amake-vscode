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

class ProgressBar implements vscode.Disposable {
    private bar;
    private progress?: vscode.Progress<{ message?: string; increment?: number }>;
    private token?: vscode.CancellationToken;
    private done: Promise<boolean>;
    private resolve?: ((value: boolean) => void);
    private reject?: (() => void);
    private currentPercentage = 0;
    private onDone?: ((bar: ProgressBar) => void);

    constructor(readonly id: string, cancellable: boolean = false, onDone?: (bar: ProgressBar) => void) {
        this.onDone = onDone;
        this.done = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        this.bar = vscode.window.withProgress({
            title: id,
            cancellable: cancellable,
            location: vscode.ProgressLocation.Notification,
        },
            async (progress, token) => {
                this.progress = progress;
                this.token = token;
                await this.done;
                console.debug(`${this.id} terminated`);
            });
    }

    dispose() {
        this.resolve?.(true);
        this.onDone?.(this);
    }

    public onCancellationRequested(callback: () => any) {
        this.token?.onCancellationRequested(callback);
    }

    public report(percentage?: number, message?: string) {
        let increment = undefined;
        if (percentage !== undefined && !Number.isNaN(percentage)) {
            increment = percentage - this.currentPercentage;
            this.currentPercentage = percentage;
        }
        this.progress?.report({ message: message, increment: increment });
        if (percentage !== undefined && percentage >= 100) {
            this.dispose();
        }
    }
};

class ProgressSet implements vscode.Disposable {
    private bars: { [id: string]: ProgressBar } = {};
    private onCancel: (() => any) | undefined = undefined;
    public get(id: string, cancellable: boolean = false) {
        if (!(id in this.bars)) {
            this.bars[id] = new ProgressBar(id, cancellable, (bar: ProgressBar) => this.barTerminated(bar));
        }
        return this.bars[id];
    }
    public clear(id: string) {
        if (id in this.bars) {
            this.bars[id].dispose();
        }
    }
    private barTerminated(bar: ProgressBar) {
        for (let id in this.bars) {
            if (this.bars[id] === bar) {
                delete this.bars[id];
                return;
            }
        }
    }
    public onCancellationRequested(callback: () => any) {
        this.onCancel = callback;
        for (let id in this.bars) {
            this.bars[id].onCancellationRequested(this.onCancel);
        }
    }
    dispose() {
        for (let id in this.bars) {
            this.bars[id].dispose();
        }
    }
};

class LogStream implements vscode.Disposable {
    static readonly _expr = /\[([\d:.]+)\]\[(\w+)\]\s*(.+?):\s*(.+)?/;
    static readonly _progressExpr = /(.+) - (.+)\/(.+)/;
    static readonly _sequenceExpr = /\x1b\[./;
    
    public bars = new ProgressSet();

    constructor(readonly output: vscode.LogOutputChannel) {
    }

    dispose() {
        this.bars.dispose();
    }

    processLine(line: string) {
        const [m, ts, level, id, msg] = LogStream._expr.exec(line) || [];
        if (m) {
            let out = this.output.info;
            switch (level) {
                case 'DEBUG':
                    out = this.output.debug;
                    break;
                case 'WARNING':
                    out = this.output.warn;
                    break;
                case 'STATUS':
                    // this.bars.clear(id);
                    return;
                case 'PROGRESS':
                    {
                        const [bm, pmsg, nStr, totStr] = LogStream._progressExpr.exec(msg) || [];
                        if (bm) {
                            if (nStr === 'done') {
                                this.bars.clear(id);
                            } else {
                                const bar = this.bars.get(id);
                                const n = parseInt(nStr);
                                const total = parseInt(totStr);
                                let progress = undefined;
                                if (total > 0) {
                                    progress = 100 * n / total;
                                }
                                bar.report(progress, pmsg);
                            }
                        } else {
                            console.debug('non matching progress');
                        }
                    }
                    return;
                case 'ERROR':
                case 'CRITICAL':
                    out = this.output.error;
                    break;
            }
            out(`${id}: ${msg}`);
        } else {
            if (!LogStream._sequenceExpr.exec(line)) {
                this.output.appendLine(line);
            }
        }
    }
};

export async function channelExec(command: string,
    parameters: string[] = [],
    title: string | undefined = undefined,
    cancellable: boolean = true,
    cwd: string | undefined = undefined,
    diagnostics: vscode.DiagnosticCollection | undefined = undefined) {
    const commandName = command === 'code' ? parameters[0] : command;
    let stream = new Stream('python', ['-u', '-m', 'dan', command, ...parameters], { cwd: cwd });
    title = title ?? `Executing ${commandName} ${parameters.join(' ')}`;
    const channel = getOutputChannel();
    channel.clear();
    channel.show();
    channel.info('executing:', commandName);
    channel.trace('command args:', ...parameters);
    diagnostics?.clear();
    const barExpr = /(\d+)-(.+):\s+(?:(\d+?)%\|.+?\|)?\s*(.+?)\s\[(.+?)\]/;
    const logStream = new LogStream(channel);
    logStream.bars.get('make', true);
    logStream.bars.onCancellationRequested(() => stream.kill());
    stream.onLine((line: string, isError) => {
        if (!handleDiagnostics(line, diagnostics)) {
            logStream.processLine(line);
        }
    });
    const rc = await stream.finished();
    const statusStr = rc === 0 ? 'succeed' : 'failed';
    logStream.dispose();
    if (rc !== 0) {
        channel.error(`command: ${commandName} failed`);
        vscode.window.showErrorMessage(`dan: ${commandName} ${statusStr}: see output log`);
        channel.show();
        throw Error(`command: ${commandName} failed`);
    } else {
        channel.info(`command: ${commandName} succeed`);
    }
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

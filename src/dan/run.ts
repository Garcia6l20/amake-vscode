import * as vscode from "vscode";
import * as cp from "child_process";

function processBuffer(msg: Buffer, isError: boolean, fn: (line: string, isError: boolean) => void) {
    const str = msg.toString();
    for (const line of str.split(/\r?\n/)) {
        if (line.length > 0) {
            fn(line, isError);
        }
    }
}

export function streamExec(
    command: string[],
    options: cp.SpawnOptions = {}
) {
    const spawned = cp.spawn(command[0], command.slice(1), options);
    return {
        onLine(fn: (line: string, isError: boolean) => void) {
            spawned.stdout?.on("data", (msg: Buffer) => processBuffer(msg, false, fn));
            spawned.stderr?.on("data", (msg: Buffer) => processBuffer(msg, true, fn));
        },
        kill(signal?: NodeJS.Signals) {
            spawned.kill(signal || "SIGKILL");
        },
        finished() {
            return new Promise<number>(res => {
                spawned.on("exit", code => res(code ? code : 0));
            });
        }
    };
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
    let stream = streamExec(['python', '-m', 'dan', command, ...parameters], { cwd: cwd });
    title = title ?? `Executing ${command} ${parameters.join(' ')}`;
    const channel = getOutputChannel();
    channel.clear();
    channel.show();
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
                if (isError) {
                    const barmatch = /(.+):\s+(\d+)%\|/g.exec(line);
                    if (barmatch) {
                        const percentage = parseInt(barmatch[2]);
                        const increment = percentage - oldPercentage;
                        oldPercentage = percentage;
                        if (increment > 0) {
                            progress.report({ increment: increment, message: barmatch[1] });
                        }
                    }
                }
                if (!handleDiagnostics(line, diagnostics)) {
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

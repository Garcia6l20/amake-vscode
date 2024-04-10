import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { Dan } from '../extension';
import * as commands from './commands';
import { channelExec, getLogArgs } from "./run";
import { showQuickEnumPick, showQuickStringListPick } from './pickers';

enum BuildType {
    debug = 'debug',
    release = 'release',
    releaseMinSize = 'release_min_size',
    releaseDebugInfos = 'release_debug_infos',
};

enum DefaultLibraryType {
    static = 'static',
    shared = 'shared',
};

interface ToolchainSettings {
    build_type: BuildType, // eslint-disable-line
    compile_flags: string[], // eslint-disable-line
    link_flags: string[], // eslint-disable-line
    default_library_type: DefaultLibraryType, // eslint-disable-line
};

interface BuildSettings {
    toolchain: string,
    config: ToolchainSettings,

    // ingoring rest for now...
};

export interface Settings {
    source_path: string, // eslint-disable-line
    build_path: string, // eslint-disable-line
    current_context: string, // eslint-disable-line

    settings: { [context: string]: BuildSettings },
};

export interface OptionDescription {
    name: string,
    fullname: string,
    help: string,
    type: string,
    value: string,
    default: string,
};

interface ToolchainConfig {
    type: string,
    version: string,
    cc: string,
    cxx: string,
    arch: string,
    system: string,
    dbg?: string,

    env: { [key: string]: string },
};

interface ToolchainsConfig {
    tools: { [name: string]: string };
    toolchains: { [name: string]: ToolchainConfig };
};

function readAll(filePath: string): Promise<Buffer> {
    return new Promise((res, rej) => {
        fs.readFile(filePath, (err, data) => {
            if (err !== null) {
                rej(err);
            } else {
                res(data);
            }
        });
    });
}

function enumKeys<O extends object, K extends keyof O = keyof O>(obj: O): K[] {
    return Object.keys(obj).filter(k => !Number.isNaN(k)) as K[];
}


function objectToSettingsArgs<T extends Object>(obj: T, prefix?: string, filter?: any) {
    let args: string[] = [];
    let settingsKeys = Object.keys(obj);
    if (filter) {
        settingsKeys = settingsKeys.filter(filter);
    }
    type SettingsKeyStrings = keyof T;
    for (const key of settingsKeys) {
        const value = obj[key as SettingsKeyStrings];
        const settingPath = prefix ? `${prefix}.${key}` : key;
        if (value instanceof Array) {
            if (value.length) {
                args.push('-s', `${settingPath}=${value.join(';')}`);
            }
        } else if (value instanceof Object) {
            args.push(...objectToSettingsArgs(value, settingPath));
        } else {
            args.push('-s', `${settingPath}=${value}`);
        }
    }
    return args;
}

export interface Context {
    name: string,
    settings: BuildSettings,
    options: OptionDescription[],
};


function makeListPicker(label: string, values: string[]) {

    class Pick implements vscode.QuickPickItem {
        readonly label = label;
        readonly description = values.join(' ');
        async action() {
            values = await showQuickStringListPick(values);
        }
    };
    return new Pick();
};

function makeEnumPicker<E extends object>(label: string, value: any, enumObj: E) {

    class Pick implements vscode.QuickPickItem {
        readonly label = label;
        readonly description = value.toString();
        async action() {
            value = await showQuickEnumPick(enumObj) ?? value;
        }
    };
    return new Pick();
}

export class DanConfig {
    private settings: Settings | undefined;
    private options: { [context: string]: OptionDescription[] | undefined } = {};
    private contextChangeEvent = new vscode.EventEmitter<Context | undefined>();
    private toolchainsConfig?: ToolchainsConfig;
    private watcher: vscode.FileSystemWatcher;
    private buildFiles: vscode.Uri[] = [];

    constructor(private readonly ext: Dan) {
        this.watcher = vscode.workspace.createFileSystemWatcher("**/dan-build.py", true, false, true);
        this.watcher.onDidChange(this.buildFileChanged, this);
    }

    get currentConfigPath() {
        return path.join(this.ext.buildPath, 'dan.config.json');
    }

    get userConfigPath() {
        return path.join(this.ext.projectRoot, 'dan-config.py');
    }

    private buildFileChanged(f: vscode.Uri) {
        if (this.buildFiles.find(b => b.path === f.path)) {
            console.debug(`${f.path} changed re-configuring`);
            this.doConfigure();
        }
    }

    public async reload(updateContext: boolean = true) {
        if (fs.existsSync(this.currentConfigPath)) {
            console.log('reloading dan configuration');
            try {
                const data = await readAll(this.currentConfigPath);
                this.settings = JSON.parse(data.toString()) as Settings;
                for (const context in this.settings) {
                    this.options[context] = await commands.codeCommand<OptionDescription[]>(this.ext, 'get-options', context);
                }
                if (updateContext) {
                    await this.setCurrentContext(this.settings.current_context, false);
                }
                const buildFiles = await commands.codeCommand<string[]>(this.ext, 'get-buildfiles', '--context', this.settings.current_context);
                this.buildFiles = buildFiles.map((p) => vscode.Uri.file(p));
            } catch (err) {
                console.error(err);
            }
        }
        if (!this.toolchainsConfig) {
            const configPath = path.join(os.homedir(), '.dan', 'toolchains.json');
            if (fs.existsSync(configPath)) {
                try {
                    const data = await readAll(configPath);
                    this.toolchainsConfig = JSON.parse(data.toString());
                } catch (err) {
                    console.error(err);
                }
            } else {
                vscode.window.showErrorMessage('No toolchan found, please run "dan scan-toolchains" and reload vscode');
            }
        }
    }

    private static getSettingsArgs(buildSettings: BuildSettings) {
        return objectToSettingsArgs(buildSettings, undefined, (k: string) => k !== 'toolchain');
    }

    private static getOptionsArgs(options: OptionDescription[]) {
        return options.map((o) => {
            return ['-o', `${o.fullname}=${o.value}`];
        }).flat();
    }

    get baseConfigArgs() {
        return ['-B', this.ext.buildPath, '-S', this.ext.projectRoot];
    }

    async doConfigure(context?: string) {
        if (!context) {
            if (!this.settings) {
                throw Error();
            }
            context = this.settings.current_context;
        }
        let args = this.baseConfigArgs;
        if (context) {
            const buildSettings = this.settings?.settings[context] ?? this.defaultBuildSettings();
            const buildOptions = this.options[context] ?? [];
            args.push(...getLogArgs(), ...DanConfig.getSettingsArgs(buildSettings), ...DanConfig.getOptionsArgs(buildOptions));
            args.push('--toolchain', buildSettings.toolchain,
                context);
        }

        await channelExec('configure', args, undefined, true, this.ext.projectRoot);
        await this.reload();
    }

    defaultBuildSettings(): BuildSettings {
        return {
            toolchain: 'undefined',
            config: {
                build_type: BuildType.debug, // eslint-disable-line
                compile_flags: new Array(), // eslint-disable-line
                default_library_type: DefaultLibraryType.static, // eslint-disable-line
            } as ToolchainSettings,
        } as BuildSettings;
    }

    buildSettings(context: string) {
        if (!this.settings) {
            this.settings = {
                source_path: 'undefined', // eslint-disable-line
                build_path: 'undefined', // eslint-disable-line
                settings: {},
            } as Settings;
        }

        if (!(context in this.settings.settings)) {
            this.settings.settings[context] = this.defaultBuildSettings();
        }
        return this.settings.settings[context];
    }

    async configureContext(context: string) {

        const buildSettings = this.buildSettings(context);

        const makePicker = (label: string, description: string | undefined, job: () => Promise<void>) => {
            class Pick implements vscode.QuickPickItem {
                readonly label = label;
                readonly description = description;
                async action() {
                    await job();
                }
            };
            return new Pick();
        };

        if (buildSettings.toolchain === 'undefined') {
            const toolchains = await commands.getToolchains(this.ext);
            const toolchain = await vscode.window.showQuickPick(toolchains, {
                title: 'Select toolchain',
            });
            if (!toolchain) {
                return;
            }
            buildSettings.toolchain = toolchain;
        }


        while (true) {

            let pickItems = [
                makePicker('toolchain', buildSettings.toolchain, async () => {
                    const toolchains = await commands.getToolchains(this.ext);
                    buildSettings.toolchain = await vscode.window.showQuickPick(toolchains, { title: 'Select toolchain' }) ?? buildSettings.toolchain;
                }),
                makePicker('config', undefined, async () => {
                    while (true) {
                        let cxxPickItems = [
                            makeEnumPicker('build type', buildSettings.config.build_type, BuildType),
                            makeListPicker('compile flags', buildSettings.config.compile_flags),
                            makeListPicker('link flags', buildSettings.config.link_flags),
                            makeEnumPicker('default library type', buildSettings.config.default_library_type, DefaultLibraryType),
                        ];
                        const item = await vscode.window.showQuickPick(cxxPickItems, {
                            title: `${context} cxx configuration`,
                            placeHolder: 'Press escape to stop',
                            ignoreFocusOut: true
                        } as vscode.QuickPickOptions);
                        if (!item) {
                            return;
                        }
                        await item.action();
                    };

                }),
                makePicker('options', undefined, async () => {

                    if (!this.options[context]) {
                        await this.doConfigure(context);
                        this.options[context] = await commands.codeCommand<OptionDescription[]>(this.ext, 'get-options', context);
                    }

                    const buildOptions = this.options[context];
                    if (!buildOptions) {
                        throw Error('No options');
                    }

                    let modified = false;
                    let optionPickItems = [];
                    for (let opt of buildOptions) {
                        optionPickItems.push(makePicker(opt.name, opt.help, async () => {
                            const oldValue = opt.value;
                            opt.value = await vscode.window.showInputBox({ prompt: `Enter ${opt.name} value`, value: opt.value }, undefined) ?? opt.value;
                            modified = modified || oldValue !== opt.value;
                        }));
                    }
                    const item = await vscode.window.showQuickPick(optionPickItems, {
                        title: `${context} options configuration`,
                        placeHolder: 'Press escape to stop',
                        ignoreFocusOut: true
                    } as vscode.QuickPickOptions);
                    if (!item) {
                        return;
                    }
                    await item.action();
                    if (modified) {
                        await this.doConfigure(context);
                    }
                }),
            ];

            const item = await vscode.window.showQuickPick(pickItems, {
                title: `${context} configuration`,
                placeHolder: 'Press escape to stop',
                ignoreFocusOut: true
            } as vscode.QuickPickOptions);
            if (!item) {
                break;
            }
            await item.action();
        }
        await this.doConfigure(context);
    }

    async setCurrentContext(name: string, reload: boolean = true) {
        if (!this.contextNames.includes(name)) {
            throw Error(`No such context ${name}`);
        }
        if (!this.settings) {
            throw Error('No settings');
        }
        this.settings.current_context = name;
        await channelExec('set', ['context', name], undefined, true, this.ext.projectRoot);

        if (reload) {
            await this.reload(false);
        }
        this.contextChangeEvent.fire(this.currentContext);
    }

    private _currentContext?: Context;
    public get currentContext(): Context | undefined {
        if (!this.settings) {
            return undefined;
        }
        const name = this.settings.current_context;
        if (!this._currentContext || this._currentContext.name !== name) {
            this._currentContext = {
                name: name,
                settings: this.settings.settings[name],
                options: this.options[name] ?? [],
            };
        }
        return this._currentContext;
    }

    public get contextNames() {
        if (this.settings && this.settings.settings) {
            return Object.keys(this.settings.settings);
        } else {
            return [];
        }
    }

    public get currentToolchainConfig() {
        if (this.toolchainsConfig) {
            const ctx = this.currentContext;
            if (ctx) {
                return this.toolchainsConfig?.toolchains[ctx.settings.toolchain];
            }
        }
    }

    public get configured() {
        return !!this.settings;
    }

    onContextChanged(callback: (c: Context | undefined) => void) {
        this.contextChangeEvent.event(callback);
    }

    async newConfiguration() {
        let value = undefined;
        if (fs.existsSync(this.userConfigPath)) {
            vscode.window.showInformationMessage('Use user auto-configuration');
            await channelExec('configure', this.baseConfigArgs, undefined, true, this.ext.projectRoot);
            await this.reload();
        } else {
            if (!this.configured) {
                value = 'default';
            }
            const newConfig = await vscode.window.showInputBox({
                prompt: 'Enter new configuration name',
                value: value,
                ignoreFocusOut: true,
            });
            if (newConfig) {
                await this.configureContext(newConfig);
            }
        }
    }

    async uiConfiguration() {

        class ContextPickItem {
            constructor(public label: string) { }
        };

        while (true) {
            let confContexts: string[] = this.contextNames ?? [];

            let pickItems = confContexts.map((label) => {
                return new ContextPickItem(label);
            });

            let pick = vscode.window.createQuickPick<ContextPickItem>();
            pick.ignoreFocusOut = true;
            pick.items = pickItems;
            pick.title = 'Select configuration context';
            pick.placeholder = 'Enter new configuration name here  (press escape to quit)';
            // pick.value = pickItems.length ? pickItems[0].label : 'default';
            const context = await new Promise<string | undefined>((res, rej) => {
                pick.onDidAccept(() => {
                    if (pick.selectedItems.length) {
                        res(pick.selectedItems[0].label);
                    } else {
                        res(pick.value);
                    }
                });
                pick.onDidHide(() => {
                    res(undefined);
                });
                pick.show();
            });
            pick.dispose();

            if (!context) {
                return;
            }
            await this.configureContext(context);
        }
    }
};




import * as vscode from 'vscode';
import * as path from 'path';
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
    cxx_flags: string[], // eslint-disable-line
    default_library_type: DefaultLibraryType, // eslint-disable-line
};

interface BuildSettings {
    toolchain: string,
    cxx: ToolchainSettings,

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
        if (value instanceof Object) {
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

export class DanConfig {
    private settings: Settings | undefined;
    private options: { [context: string]: OptionDescription[] | undefined } = {};
    private contextChangeEvent = new vscode.EventEmitter<Context|undefined>();

    constructor(private readonly ext: Dan) {
    }

    public async reload() {
        const configPath = path.join(this.ext.buildPath, 'dan.config.json');
        if (fs.existsSync(configPath)) {
            console.log('reloading dan configuration');
            try {
                const data = await readAll(configPath);
                this.settings = JSON.parse(data.toString()) as Settings;
                for (const context in this.settings) {
                    this.options[context] = await commands.codeCommand<OptionDescription[]>(this.ext, 'get-options', context);
                }
                await this.setCurrentContext(this.settings.current_context);
            } catch (err) {
                console.error(err);
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

    async doConfigure(context?: string) {
        if (!context) {
            if (!this.settings) {
                throw Error();
            }
            context = this.settings.current_context;
        }
        let args = ['-B', this.ext.buildPath, '-S', this.ext.projectRoot];
        const buildSettings = this.settings?.settings[context] ?? this.defaultBuildSettings();
        const buildOptions = this.options[context] ?? [];
        args.push(...getLogArgs(), ...DanConfig.getSettingsArgs(buildSettings), ...DanConfig.getOptionsArgs(buildOptions));
        args.push('--toolchain', buildSettings.toolchain,
            context);
        return channelExec('configure', args, undefined, true, this.ext.projectRoot);
    }

    defaultBuildSettings(): BuildSettings {
        return {
            toolchain: 'default',
            cxx: {
                build_type: BuildType.debug, // eslint-disable-line
            } as ToolchainSettings,
        } as BuildSettings;
    }

    buildSettings(context: string) {
        if (!this.settings) {
            this.settings = {
                source_path: 'unknown', // eslint-disable-line
                build_path: 'unknown', // eslint-disable-line
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


        while (true) {

            let pickItems = [
                makePicker('toolchain', buildSettings.toolchain, async () => {
                    const toolchains = await commands.getToolchains(this.ext);
                    buildSettings.toolchain = await vscode.window.showQuickPick(toolchains, { title: 'Select toolchain' }) ?? buildSettings.toolchain;
                }),
                makePicker('cxx', undefined, async () => {
                    while (true) {
                        const cxxFlags = buildSettings.cxx.cxx_flags.join(' ');
                        let cxxPickItems = [
                            makePicker('build type', buildSettings.cxx.build_type, async () => {
                                buildSettings.cxx.build_type = await showQuickEnumPick(BuildType, { title: 'Select build type' }) ?? buildSettings.cxx.build_type;
                            }),
                            makePicker('cxx flags', cxxFlags, async () => {
                                buildSettings.cxx.cxx_flags = await showQuickStringListPick(buildSettings.cxx.cxx_flags);
                            }),
                            makePicker('default library type', buildSettings.cxx.default_library_type, async () => {
                                buildSettings.cxx.default_library_type = await showQuickEnumPick(DefaultLibraryType, {
                                    title: 'Select default library type',
                                }) ?? buildSettings.cxx.default_library_type;
                            }),
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

    async setCurrentContext(name: string) {
        if (!this.contextNames.includes(name)) {
            throw Error(`No such context ${name}`);
        }
        if (!this.settings) {
            throw Error('No settings');
        }
        this.settings.current_context = name;
        await channelExec('set', ['context', name], undefined, true, this.ext.projectRoot);

        this.contextChangeEvent.fire(this.currentContext);
    }

    private _currentContext?: Context;
    public get currentContext(): Context|undefined {
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

    public get configured() {
        return !!this.settings;
    }

    onContextChanged(callback: (c: Context|undefined) => void) {
        this.contextChangeEvent.event(callback);
    }

    async uiConfiguration() {

        class ContextPickItem {
            constructor(public label: string) { }
        };

        while (true) {
            await this.reload();

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




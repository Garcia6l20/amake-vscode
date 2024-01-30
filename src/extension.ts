// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as commands from './dan/commands';
import * as debuggerModule from './dan/debugger';
import { Target } from './dan/targets';
import { StatusBar } from './status';
import { DanTestAdapter } from './dan/testAdapter';
import { TestHub, testExplorerExtensionId } from 'vscode-test-adapter-api';
import { Log, TestAdapterRegistrar } from 'vscode-test-adapter-util';
import { CppToolsApi, Version, getCppToolsApi } from 'vscode-cpptools';
import { ConfigurationProvider as CppToolsConfigurationProvider } from './cpptools';
import { str2cmdline } from './dan/run';
import * as configuration from './dan/configuration';

class TargetPickItem {
	label: string;
	constructor(public readonly target: Target) {
		this.label = target.fullname;
	}
};

type StringMap = { [key: string]: string };

export class Dan implements vscode.Disposable {
	codeConfig: vscode.WorkspaceConfiguration;
	workspaceFolder: vscode.WorkspaceFolder;
	projectRoot: string;
	
	_debugCommandArguments: string = "configure";
	
	targets: Target[];

	_launchTarget?: string;
	launchTargetArguments: StringMap = {};
	launchTargetChanged = new vscode.EventEmitter<Target | undefined>();
	
	_buildTargets: string[] = [];
	// buildTargetsId?: string[] = [];
	buildTargetsChanged = new vscode.EventEmitter<Target[]>();
	
	tests: string[] = [];
	testsChanged = new vscode.EventEmitter<string[]>();
	
	buildDiagnosics: vscode.DiagnosticCollection;
	
	configuration: configuration.DanConfig;

	private readonly _statusBar;

	constructor(public readonly extensionContext: vscode.ExtensionContext) {
		this.codeConfig = vscode.workspace.getConfiguration("dan");
		this.buildDiagnosics = vscode.languages.createDiagnosticCollection('dan');

		extensionContext.subscriptions.push(this.buildDiagnosics);
		if (vscode.workspace.workspaceFolders) {
			this.workspaceFolder = vscode.workspace.workspaceFolders[0];
			this.projectRoot = this.workspaceFolder.uri.fsPath;
		} else {
			throw new Error('Cannot resolve project root');
		}
		this.targets = [];
		vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
			this.codeConfig = vscode.workspace.getConfiguration("dan");
		});

		this.configuration = new configuration.DanConfig(this);
		this._statusBar = new StatusBar(this);

		this.loadWorkspaceState();
	}

	public get currentContext() {
		return this.configuration.currentContext;
	}

	getTargetId(target?: Target) {
		if (target && this.currentContext) {
			return target.fullname.replace(`${this.currentContext.name}.`, '');
		}
	}

	getTargetById(id?: string): Target|undefined {
		if (id) {
			return this.targets.find((target: Target) => {
				return this.getTargetId(target) === id;
			});
		}
	}
	
	public get buildTargets() {
		return this.targets.filter((target: Target) => {
			const id = this.getTargetId(target);
			return this._buildTargets.includes(id!);
		});
	}

	public get launchTarget() {
		return this.targets.find((target: Target) => {
			const id = this.getTargetId(target);
			return this._launchTarget === id;
		});
	}

	private loadWorkspaceState() {
		this.tests = this.extensionContext.workspaceState.get<string[]>('selectedTests') ?? [];
		this.testsChanged.fire(this.tests);
		this.testsChanged.event((value: string[]) => {
			this.extensionContext.workspaceState.update('selectedTests', value);
		});

		this._buildTargets = this.extensionContext.workspaceState.get<string[]>('buildTargets') ?? [];
		this.buildTargetsChanged.fire(this.buildTargets);
		this.buildTargetsChanged.event((value: Target[]) => {
			this.extensionContext.workspaceState.update('buildTargets', this._buildTargets);
		});

		this._launchTarget = this.extensionContext.workspaceState.get<string>('launchTarget');
		this.launchTargetChanged.fire(this.launchTarget);
		this.launchTargetChanged.event((value: Target | undefined) => {
			this.extensionContext.workspaceState.update('launchTarget', this._launchTarget);
		});

		this.launchTargetArguments = this.extensionContext.workspaceState.get<StringMap>('launchTargetArguments', this.launchTargetArguments);
		this._debugCommandArguments = this.extensionContext.workspaceState.get<string>('debugCommandArguments', this._debugCommandArguments);
	}

	getConfig<T>(name: string): T | undefined {
		return this.codeConfig.get<T>(name);
	}

	get buildPath(): string {
		const p = this.projectRoot + '/' + this.getConfig<string>('buildFolder') ?? 'build';
		return p//
			.replace('${workspaceFolder}', this.workspaceFolder.uri.fsPath);
	}

	/**
	 * Create the instance
	 */
	static async create(context: vscode.ExtensionContext) {
		gExtension = new Dan(context);

		await gExtension.registerCommands();
		await gExtension.onLoaded();
	}

	/**
	 * Dispose the instance
	 */
	dispose() {
		(async () => {
			this.cleanup();
		})();
	}

	async cleanup() {
	}

	async reloadConfig() {
		this.targets = await commands.getTargets(this);
		
		// fire events
		this.launchTargetChanged.fire(this.launchTarget);
		this.buildTargetsChanged.fire(this.buildTargets);
		this.testsChanged.fire(this.tests);
	}

	async promptLaunchTarget(fireEvent: boolean = true) {
		let targets = this.targets.filter(t => t.executable === true);
		targets.sort((l, r) => l.fullname < r.fullname ? -1 : 1);
		let targetId = await vscode.window.showQuickPick(targets.map(t => this.getTargetId(t)!));
		if (fireEvent && targetId) {
			this._launchTarget = targetId;
			this.launchTargetChanged.fire(this.launchTarget);
		}
	}

	async promptBuildTargets() {
		let targets = this.targets;
		targets.sort((l, r) => l.fullname < r.fullname ? -1 : 1);
		let pick = vscode.window.createQuickPick<TargetPickItem>();
		pick.canSelectMany = true;
		pick.items = targets.map(t => new TargetPickItem(t));
		let promise = new Promise<Target[]>((res, rej) => {
			pick.show();
			pick.onDidAccept(() => {
				pick.hide();
			});
			pick.onDidHide(() => {
				if (pick.selectedItems.length === 0) {
					rej();
				} else {
					if (pick.selectedItems.length === this.targets.length) {
						res([]); // aka.: all
					} else {
						res(pick.selectedItems.map(pt => pt.target));
					}
				}
			});
		});
		try {
			targets = await promise;
			this._buildTargets = targets.map(t => this.getTargetId(t)!);
			this.buildTargetsChanged.fire(this.buildTargets);
		} finally {
			return this.buildTargets;
		}
	}

	async promptTests() {
		let tests = this.tests = await commands.getTests(this);
		class TestPick {
			constructor(public label: string) { }
		};
		let pick = vscode.window.createQuickPick<TestPick>();
		pick.canSelectMany = true;
		pick.items = tests.map(t => new TestPick(t));
		let promise = new Promise<string[]>((res, rej) => {
			pick.show();
			pick.onDidAccept(() => {
				pick.hide();
			});
			pick.onDidHide(() => {
				res(pick.selectedItems.map(pt => pt.label));
			});
		});
		tests = await promise;
		pick.dispose();
		this.tests = tests;
		this.testsChanged.fire(this.tests);
		return this.tests;
	}

	async debuggerPath() {
		const debuggerPath = this.getConfig<string>('debuggerPath');
		if (debuggerPath) {
			return debuggerPath;
		}
		return this.configuration.currentToolchainConfig?.dbg;
	}

	async ensureConfigured() {
		if (!this.configuration.configured) {
			await this.configure();
		}
	}

	notifyUpdated() {
		if (this._cppToolsApi !== undefined && this._cppToolsProvider !== undefined) {
			this._cppToolsProvider.resetCache();
			this._cppToolsApi.didChangeCustomConfiguration(this._cppToolsProvider);
		}
	}

	async configure(ui = false, newConfiguration = false) {
		if (!this.configuration.configured) {
			await this.configuration.reload();
			newConfiguration = !this.configuration.configured;
		}
		if (newConfiguration) {
			await this.configuration.newConfiguration();
		} else if (ui) {
			await this.configuration.uiConfiguration();
		} else if(this.currentContext) {
			await this.configuration.doConfigure();
		} else {
			console.error('No currentContext');
		}

		this.notifyUpdated();

		this.extensionContext.environmentVariableCollection.replace('DAN_BUILD_PATH', this.buildPath);
		if (this.currentContext) {
			this.extensionContext.environmentVariableCollection.replace('DAN_TOOLCHAIN', this.currentContext.settings.toolchain);
		}

		await this.reloadConfig();
	}

	async selectCurrentContext() {
		await this.ensureConfigured();
		const context = await vscode.window.showQuickPick(this.configuration.contextNames);
		if (context) {
			await this.configuration.setCurrentContext(context);
			await this.reloadConfig();
		}
	}

	async build(debug = false) {
		await this.ensureConfigured();
		await commands.build(this, this.buildTargets, debug);
		this.notifyUpdated();
	}

	async clean() {
		if (this.configuration.configured) {
			await commands.clean(this);
		}
	}

	makeArgumentList(str: string) {
		const testsIndex = str.indexOf('${selectedTests}');
		if (testsIndex !== -1) {
			str = str.replace('${selectedTests}', this.tests.join(' '));
		}
		let args = str2cmdline(str, {
			workspaceFolder: this.workspaceFolder.uri.fsPath,
			rootFolder: this.projectRoot,
			buildFolder: this.buildPath,
			launchTarget: this.launchTarget?.fullname,
			targetSrcFolder: this.launchTarget?.srcPath,
			targetBuildFolder: this.launchTarget?.buildPath,
		});
		return args;
	}

	async run() {
		await this.ensureConfigured();
		if (!this.launchTarget || !this.launchTarget.executable) {
			await this.promptLaunchTarget();
		}
		if (this.launchTarget && this.launchTarget.executable) {
			const args = this.makeArgumentList(this.launchTargetArguments[this._launchTarget!] ?? "");
			await commands.run(this, args);
		}
	}

	async debug() {
		await this.ensureConfigured();
		if (!this.launchTarget || !this.launchTarget.executable) {
			await this.promptLaunchTarget();
		}
		if (this.launchTarget && this.launchTarget.executable) {
			await commands.build(this, [this.launchTarget]);
			const args = this.makeArgumentList(this.launchTargetArguments[this._launchTarget!] ?? "");
			await debuggerModule.debug(this.launchTarget, args);
		}
	}

	async test() {
		await this.ensureConfigured();
		await commands.test(this);
	}

	async executableArguments(target?: Target) {
		if (!target) {
			await this.promptLaunchTarget(false);
			target = this.launchTarget;
		}
		if (!target) { return; }
		const id = this.getTargetId(target)!;
		const args = await vscode.window.showInputBox({
			title: `Set ${target} arguments`,
			value: this.launchTargetArguments[id]
		});
		if (args === undefined) { return; }
		this.launchTargetArguments[id] = args;
		this.extensionContext.workspaceState.update('launchTargetArguments', this.launchTargetArguments);
	}

	async debugWithArgs() {
		await this.executableArguments(this.launchTarget);
		await this.debug();
	}
	
	async debugCommandArguments() {
		const args = await vscode.window.showInputBox({
			title: 'dan command arguments',
			value: this._debugCommandArguments
		});
		if (args === undefined) { return; }
		this._debugCommandArguments = args;
		this.extensionContext.workspaceState.update('debugCommandArguments', this._debugCommandArguments);
		return this._debugCommandArguments;
	}

	async commandDebug() {
		const command = await this.debugCommandArguments();
		if (command === undefined) { return; }
		const args = this.makeArgumentList(command);
		await commands.debugExec(this, args);
	}

	async registerCommands() {
		const register = (id: string, callback: (...args: any[]) => any, thisArg?: any) => {
			this.extensionContext.subscriptions.push(
				vscode.commands.registerCommand(`dan.${id}`, callback, thisArg)
			);
		};

		register('scanToolchains', async () => commands.scanToolchains(this));
		register('newConfig', async () => this.configure(true, true));
		register('configure', async () => this.configure(true));
		register('build', async () => this.build());
		register('debugBuild', async () => this.build(true));
		register('clean', async () => this.clean());
		register('run', async () => this.run());
		register('debug', async () => this.debug());
		register('test', async () => this.test());
		register('clearDiags', () => {
			this.buildDiagnosics.clear();
		});
		register('selectLaunchTarget', async () => this.promptLaunchTarget());
		register('selectBuildTargets', async () => this.promptBuildTargets());
		// register('selectBuildType', async () => this.promptBuildType());
		register('selectTestTargets', async () => this.promptTests());
		register('selectCurrentContext', async () => this.selectCurrentContext());
		// register('selectToolchain', async () => this.selectToolchain());
		// register('currentToolchain', async () => this.currentToolchain());
		register('executableArguments', async () => this.executableArguments());
		register('debugWithArgs', async () => this.debugWithArgs());
		register('commandDebug', async () => this.commandDebug());
	}

	async initTestExplorer() {
		// setup Test Explorer
		const testExplorerExtension = vscode.extensions.getExtension<TestHub>(
			testExplorerExtensionId
		);

		if (testExplorerExtension) {
			const testHub = testExplorerExtension.exports;
			const log = new Log('danTestExplorer', this.workspaceFolder, 'dan Explorer Log');
			this.extensionContext.subscriptions.push(log);

			// this will register a CmakeAdapter for each WorkspaceFolder
			this.extensionContext.subscriptions.push(
				new TestAdapterRegistrar(
					testHub,
					(workspaceFolder) => new DanTestAdapter(this, log),
					log
				)
			);
		}
	}

	_cppToolsApi: CppToolsApi | undefined = undefined;
	_cppToolsProvider: CppToolsConfigurationProvider | undefined = undefined;

	async initCppTools() {
		this._cppToolsApi = await getCppToolsApi(Version.v5);
		this._cppToolsProvider = new CppToolsConfigurationProvider(this);
		if (this._cppToolsApi) {
			if (this._cppToolsApi.notifyReady) {
				// Inform cpptools that a custom config provider will be able to service the current workspace.
				this._cppToolsApi.registerCustomConfigurationProvider(this._cppToolsProvider);

				// Do any required setup that the provider needs.
				// await this._cppToolsProvider.refresh();

				// Notify cpptools that the provider is ready to provide IntelliSense configurations.
				this._cppToolsApi.notifyReady(this._cppToolsProvider);
			} else {
				// Running on a version of cpptools that doesn't support v2 yet.

				// Do any required setup that the provider needs.
				// await this._cppToolsProvider.refresh();

				// Inform cpptools that a custom config provider will be able to service the current workspace.
				this._cppToolsApi.registerCustomConfigurationProvider(this._cppToolsProvider);
				this._cppToolsApi.didChangeCustomConfiguration(this._cppToolsProvider);
			}
		}

	}

	async onLoaded() {
		vscode.commands.executeCommand("setContext", "inDanProject", true);

		await this.configure();
		await this.initCppTools();
		await this.initTestExplorer();
	}
};


export let gExtension: Dan | null = null;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	await Dan.create(context);
}

// This method is called when your extension is deactivated
export async function deactivate() {
	await gExtension?.cleanup();
}

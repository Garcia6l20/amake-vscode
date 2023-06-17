// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as commands from './dan/commands';
import * as debuggerModule from './dan/debugger';
import * as path from 'path';
import { Target } from './dan/targets';
import { StatusBar } from './status';
import { DanTestAdapter } from './dan/testAdapter';
import { TestHub, testExplorerExtensionId } from 'vscode-test-adapter-api';
import { Log, TestAdapterRegistrar } from 'vscode-test-adapter-util';
import { CppToolsApi, Version, getCppToolsApi } from 'vscode-cpptools';
import { ConfigurationProvider as CppToolsConfigurationProvider } from './cpptools';
import { existsSync, readFileSync } from 'fs';


class TargetPickItem {
	label: string;
	constructor(public readonly target: Target) {
		this.label = target.fullname;
	}
};

enum BuildType {
	debug = 0,
	release = 1,
    releaseMinSize = 2,
    releaseDebugInfos = 3,

}

interface DanSettings {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	build_type: BuildType,
	// ingoring rest for now...
}

interface DanConfig {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	source_path: string,
	// eslint-disable-next-line @typescript-eslint/naming-convention
	build_path: string,
	toolchain: string,
	settings: DanSettings,
}

export class Dan implements vscode.Disposable {
	codeConfig: vscode.WorkspaceConfiguration;
	workspaceFolder: vscode.WorkspaceFolder;
	projectRoot: string;
	targets: Target[];
	launchTarget: Target | null = null;
	launchTargetChanged = new vscode.EventEmitter<Target>();
	buildTargets: Target[] = [];
	buildTargetsChanged = new vscode.EventEmitter<Target[]>();
	tests: string[] = [];
	testsChanged = new vscode.EventEmitter<string[]>();
	currentToolchainChanged = new vscode.EventEmitter<string>();
	buildDiagnosics: vscode.DiagnosticCollection;
	
	private readonly _statusBar = new StatusBar(this);

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
	}

	getConfig<T>(name: string): T | undefined {
		return this.codeConfig.get<T>(name);
	}

	get buildPath(): string {
		const p = this.projectRoot + '/' + this.getConfig<string>('buildFolder') ?? 'build';
		return p.replace('${toolchain}', this._toolchain ?? 'default');//.replace('${buildType}', this._buildType ?? 'debug');
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

	async promptLaunchTarget() {
		let targets = this.targets = await commands.getTargets(this);
		targets = targets.filter(t => t.executable === true);
		targets.sort((l, r) => l.fullname < r.fullname ? -1 : 1);
		let target = await vscode.window.showQuickPick(targets.map(t => t.fullname));
		if (target) {
			this.launchTarget = targets.filter(t => t.fullname === target)[0];
			this.launchTargetChanged.fire(this.launchTarget);
		}
		return this.launchTarget;
	}

	async promptBuildTargets() {
		let targets = this.targets = await commands.getTargets(this);
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
				res(pick.selectedItems.map(pt => pt.target));
			});
		});
		targets = await promise;
		pick.dispose();
		this.buildTargets = targets;
		this.buildTargetsChanged.fire(this.buildTargets);
		return this.buildTargets;
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

	private _toolchain: string|undefined = undefined;
	async selectToolchain() {
		const toolchains = await commands.getToolchains(this);
		this._toolchain = await vscode.window.showQuickPick(['default', ...toolchains]) ?? 'default';
		this.currentToolchainChanged.fire(this._toolchain);
		await this.configure();
	}

	private _config: DanConfig|undefined = undefined;
	get config(): DanConfig|undefined {
		if (this._config === undefined) {
			const configPath = path.join(this.buildPath, 'dan.config.json');
			if (existsSync(configPath)) {
				try {
					const data = readFileSync(configPath, 'utf8');
					this._config = JSON.parse(data) as DanConfig;
					this._toolchain = this._config.toolchain;
					this.currentToolchainChanged.fire(this._toolchain);
				} catch (err) {
					console.error(err);
				}
			}
		}
		return this._config;
	}

	async currentToolchain() {
		if (this._toolchain === undefined) {
			if (this.config) {
				this.config.toolchain;
			} else {
				await this.selectToolchain();
			}
		}
		return this._toolchain;
	}


	async ensureConfigured() {
		if (!this.config) {
			await commands.configure(this);
		}
	}

	notifyUpdated() {
		if (this._cppToolsApi !== undefined && this._cppToolsProvider !== undefined) {
			this._cppToolsProvider.resetCache();
			this._cppToolsApi.didChangeCustomConfiguration(this._cppToolsProvider);
		}
	}

	async configure() {
		this._config = undefined;
		await commands.configure(this);
		this.notifyUpdated();
	}

	async build(debug = false) {
		await this.ensureConfigured();
		await commands.build(this, this.buildTargets, debug);
		this.notifyUpdated();
	}

	async clean() {
		if (this.config) {
			await commands.clean(this);
		}
	}

	async run() {
		await this.ensureConfigured();
		if (!this.launchTarget || !this.launchTarget.executable) {
			await this.promptLaunchTarget();
		}
		if (this.launchTarget && this.launchTarget.executable) {
			await commands.run(this);
		}
	}

	async debug() {
		await this.ensureConfigured();
		if (!this.launchTarget || !this.launchTarget.executable) {
			await this.promptLaunchTarget();
		}
		if (this.launchTarget && this.launchTarget.executable) {
			await commands.build(this, [this.launchTarget]);
			await debuggerModule.debug(this.launchTarget);
		}
	}

	async test() {
		await this.ensureConfigured();
		await commands.test(this);
	}

	async registerCommands() {
		const register = (id: string, callback: (...args: any[]) => any, thisArg?: any) => {
			this.extensionContext.subscriptions.push(
				vscode.commands.registerCommand(`dan.${id}`, callback, thisArg)
			);
		};

		register('scanToolchains', async () => commands.scanToolchains(this));
		register('configure', async () => this.configure());
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
		register('selectTestTargets', async () => this.promptTests());
		register('selectToolchain', async () => this.selectToolchain());
		register('currentToolchain', async () => this.currentToolchain());
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

	_cppToolsApi: CppToolsApi|undefined = undefined;
	_cppToolsProvider: CppToolsConfigurationProvider|undefined = undefined;

	async initCppTools() {
		this._cppToolsApi = await getCppToolsApi(Version.latest);
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

		await this.ensureConfigured();
		try {
			this.targets = await commands.getTargets(this);
		} catch(e: any) {
			vscode.window.showErrorMessage(e.toString());
		}

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

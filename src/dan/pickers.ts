import * as vscode from 'vscode';

export async function showQuickEnumPick<E extends object, K extends keyof E = keyof E>(enumObj: E, options?: vscode.QuickPickOptions) {

    type EnumStrings = keyof E;

    const keys = Object.keys(enumObj).filter((v) => isNaN(Number(v)));

    const name: string | undefined = await vscode.window.showQuickPick(keys, options);
    if (name) {
        return enumObj[name as EnumStrings];
    } else {
        return undefined;
    }
}

export async function showQuickStringListPick(list?: string[]) {
    list = list ?? [];
    
    while (true) {
        let pickItems : vscode.QuickPickItem[] = [];

        for (let item of list) {
            class ListPickItem implements vscode.QuickPickItem {
                label = item;
                buttons: readonly vscode.QuickInputButton[] = [
                    {
                        iconPath: new vscode.ThemeIcon('remove'),
                        tooltip: 'remove item',
                    }
                ];
            };
            pickItems.push(new ListPickItem());
        }

        const pick = vscode.window.createQuickPick();
        pick.ignoreFocusOut = true;
        pick.items = pickItems;
        pick.canSelectMany = false;
        pick.placeholder = 'Enter new value here (Press enter or escape to stop)';
        let removed = false;
        pick.onDidTriggerItemButton((e) => {
            list = list?.filter((v) => v !== e.item.label);
            removed = true;
            pick.hide();
        });

        const item = await new Promise<string|undefined>((res, rej) => {
            pick.onDidAccept(() => {
                if (!pick.value.length) {
                    pick.hide();
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
        if (!item && !removed) {
            break;
        }
        if (item) {
            list.push(item);
        }
    }
    
    return list;
}

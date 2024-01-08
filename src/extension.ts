import * as vscode from 'vscode';
import { workspace } from 'vscode';
import { window } from 'vscode';
import Server from './server';
import Client from './client';

export function activate(context: vscode.ExtensionContext) {
	const DEFAULT_PORT: number = 8080;

	async function parseSessionUrl(url: string | undefined): Promise<URL | undefined> {
		if (!url) {
			return Promise.resolve(undefined);
		}

		let attachUrl = url;
		if (!attachUrl.match(/^[a-zA-Z]+?:\/\//)) {
			attachUrl = `ws://${attachUrl}`;
		}

		const parsedUrl = new URL(attachUrl);

		if (!parsedUrl.port) {
			parsedUrl.port = DEFAULT_PORT.toString();
		}

		return Promise.resolve(parsedUrl);
	}

	async function checkUsernameExists(): Promise<boolean> {
		if (vscode.workspace.getConfiguration('instant-code').get('username')) {
			return Promise.resolve(true);
		}

		const username = await window.showInputBox({ prompt: 'Enter username' });
		vscode.workspace.getConfiguration('instant-code').update('username', username);
		return true;
	}

	async function promptServerUrl(): Promise<URL | undefined> {
		const url = await window.showInputBox({ prompt: 'Enter server URL' });
		return parseSessionUrl(url);
	}

	context.subscriptions.push(vscode.commands.registerCommand('instant-code.startServer', async (port: number | undefined) => {
		await checkUsernameExists();
		const usedPort = port || DEFAULT_PORT;
		const server = new Server(usedPort);
		console.log(`Instant Code server started on port ${usedPort}`);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('instant-code.startSession', async () => {
		await checkUsernameExists();
		const url = await promptServerUrl();
		if (url) {
			let documentUri = window.activeTextEditor?.document.uri.toString();
			if (!documentUri) {
				workspace.openTextDocument().then((doc: vscode.TextDocument) => {
					documentUri = doc.uri.toString();
				});
			}

			if (!documentUri) {
				window.showErrorMessage("No active document, and couldn't create a new one");
				return;
			}

			Client.create(documentUri.toString(), url, true);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('instant-code.joinSession', async () => {
		await checkUsernameExists();
		const url = await promptServerUrl();
		if (url) {
			workspace.openTextDocument().then((doc: vscode.TextDocument) => {
				Client.create(doc.uri.toString(), url, false);
				window.showTextDocument(doc);
			});
		}
	}));
}

export function deactivate() { }
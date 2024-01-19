import * as vscode from 'vscode';
import { window, env } from 'vscode';
import WebSocket from 'ws';

import Logger from './logger';
import { CRDT } from './crdt';
import * as pid from './pid';
import { Pid, ClientId } from './pid';
import * as protocol from './protocol';
import { MessageTypes } from './protocol';

// eslint-disable-next-line @typescript-eslint/naming-convention

class Client {
  websocket: WebSocket;
  isHost: boolean;
  clientId: ClientId | undefined;
  bufferName: string | undefined;
  buffer: [number, number] | undefined;
  crdt: CRDT = new CRDT();
  document: vscode.TextDocument;
  subscriptions: vscode.Disposable[] = [];
  activeEdit: { kind: 'insert' | 'delete', range: vscode.Range, text: string } | undefined;

  static sockets = new Map<string, Client>();

  static async create(document: vscode.TextDocument, url: URL, isHost: boolean) {
    const client = new Client(url, isHost, document);
    Client.sockets.set(document.uri.toString(), client);
    return client;
  }

  constructor(url: URL, isHost: boolean, document: vscode.TextDocument) {
    const ws = new WebSocket(url, 'chat');
    this.websocket = ws;
    this.isHost = isHost;
    this.document = document;

    if (isHost) {
      this.setupHost();
    } else {
      this.setupGuest();
    }

    this.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => this.handleTextChange(e)));
  }

  async sendInsert(p: Pid, c: string) {
    Logger.log(`Sending insert: ${p} ${c}`);
    return this.sendMessage(MessageTypes.MSG_TEXT, [protocol.OP_INS, c, pid.serializable(p)], this.buffer!, this.clientId!);
  }

  async sendDelete(p: Pid, c: string) {
    Logger.log(`Sending delete: ${p} ${c}`);
    return this.sendMessage(MessageTypes.MSG_TEXT, [protocol.OP_DEL, pid.serializable(p), c], this.buffer!, this.clientId!);
  }

  async insertFromContentChange(change: vscode.TextDocumentContentChangeEvent) {
    const pos = this.document.positionAt(change.rangeOffset);
    const promises = change.text.split('').map(async (c, i) => {
      let previousPid = this.crdt.sortedPids[0];
      if (i > 0) {
        previousPid = this.crdt.pidAt(this.document.offsetAt(pos.translate(0, i - 1)));
      }
      let nextPid = this.crdt.sortedPids[this.crdt.sortedPids.length - 1];
      if (i < change.text.length - 1) {
        nextPid = this.crdt.pidAt(this.document.offsetAt(pos.translate(0, i)));
      }
      const p = pid.generate(this.clientId!, previousPid, nextPid);
      Logger.log(`Inserting ${c} at ${pos.translate(0, i)} with PID ${pid.show(p)}`);
      this.crdt.insert(p, c);
      await this.sendInsert(p, c);
    });
    await promises.reduce((p, c) => p.then(() => c), Promise.resolve());
  }

  async deleteFromContentChange(change: vscode.TextDocumentContentChangeEvent) {
    const deletedIndices = Array(change.rangeLength).fill(0).map((_, i) => i + change.rangeOffset);
    const deletedPids = deletedIndices.map((i) => this.crdt.pidAt(i));
    const promises = deletedPids.map(async (p) => {
      await this.sendDelete(p, this.crdt.charAt(p)!);
      this.crdt.delete(p);
    });
    await promises.reduce((p, c) => p.then(() => c), Promise.resolve());
  }

  async handleTextChange(e: vscode.TextDocumentChangeEvent) {
    Logger.log(`Text changed: ${JSON.stringify(e)}`);
    if (e.document !== this.document) {
      return;
    }

    const changes = e.contentChanges;

    const promises = changes.map(async (change) => {
      if (change.rangeLength === 0) {
        if (this.activeEdit?.kind === 'insert' && change.rangeOffset === this.activeEdit.range.start.character) {
          Logger.log(`Ignoring insert`);
          return;
        }

        await this.insertFromContentChange(change);
      } else if (change.rangeLength > 0) {
        if (this.activeEdit?.kind === 'delete' && change.range.isEqual(this.activeEdit.range) && change.text === '') {
          Logger.log(`Ignoring delete`);
          return;
        }

        // Handle a replace as a delete followed by an insert
        await this.deleteFromContentChange(change);
        await this.insertFromContentChange(change);
      } else {
        Logger.log(`Unknown change: ${JSON.stringify(change)}`);
      }
    });

    await promises.reduce((p, c) => p.then(() => c), Promise.resolve());
  }

  close() {
    Logger.log('Closing client');
    // Unbind event handlers
    this.websocket.removeAllListeners();
    this.subscriptions.forEach((s) => s.dispose());

    this.websocket.close();
  }

  async sendMessage(messageType: number, ...data: any) {
    protocol.validateMessage([messageType, ...data]);
    return this.websocket.send(JSON.stringify([messageType, ...data]));
  }

  async sendInfo() {
    return this.sendMessage(
      MessageTypes.MSG_INFO,
      false, // session_share is not implemented
      vscode.workspace.getConfiguration('instant-code').get('username'),
      protocol.VSCODE_AGENT
    );
  }

  async sendInitialBuffer() {
  }

  async handleInitialMessage(data: any[]) {
    const [_, bufferName, [bufnr, hostId], uids, lines] = data;

    this.bufferName = bufferName;
    this.buffer = [bufnr, hostId];
    Logger.log(`Buffer name: ${this.bufferName}`);

    const bigUids = uids.map((u: any) => BigInt(u));
    this.crdt.initialize({ hostId, uids: bigUids, lines });

    // Set document content from CRDT
    window.showTextDocument(this.document).then((editor) => {
      editor.edit((editBuilder) => {
        editBuilder.insert(new vscode.Position(0, 0), this.crdt.asString());
      });
    });
  }

  async requestInitialBuffer() {
    return this.sendMessage(MessageTypes.MSG_REQUEST);
  }

  editor() {
    const editor = window.visibleTextEditors.find(
      (editor) => editor.document === this.document
    );
    if (!editor) {
      window.showErrorMessage(`Could not find editor for document ${this.document.uri.toString()}`);
      this.close();
      return null;
    }

    return editor;
  }

  // A note on indices:
  // The beginning of doc _and_ beginning of the first line comprise the first two PIDs
  // Since these are not represented in the document, we need to subtract 2 from the index
  async handleRemoteInsert(pid: Pid, c: string, clientId: ClientId) {
    const i = this.crdt.insert(pid, c);
    const pos = this.document.positionAt(i - 2);
    this.activeEdit = {
      kind: 'insert',
      range: new vscode.Range(pos, pos),
      text: c,
    };
    await this.editor()?.edit((editBuilder) => {
      editBuilder.insert(pos, c);
    });
    this.activeEdit = undefined;
  }

  handleRemoteDelete(pid: Pid, c: string, clientId: ClientId) {
    const i = this.crdt.delete(pid);
    const pos = this.document.positionAt(i - 2);
    this.activeEdit = {
      kind: 'delete',
      range: new vscode.Range(pos, pos.translate(0, 1)),
      text: '',
    };
    this.editor()?.edit((editBuilder) => {
      editBuilder.delete(new vscode.Range(pos, pos.translate(0, 1)));
    });
  }

  /*
    The available message sent by the server in response to the client.

    [
            MSG_AVAILABLE, // message type [integer]
            is_first, // first client to connect to the server? [boolean]
            client_id, // unique client id assigned by the server [integer]
            session_share, // server in session share mode? [boolean]

    ]
  */
  async handleAvailableMessage(data: any[]) {
    const [_, isFirst, clientId, sessionShare] = data;

    if (isFirst && !this.isHost) {
      Logger.log('Error: guest was first to connect');
      window.showErrorMessage('Error: guest was first to connect');
      this.close();
    }
    if (sessionShare) {
      Logger.log('Error: session share not implemented');
      window.showErrorMessage('Error: session share not implemented');
      this.close();
    }

    this.clientId = clientId as ClientId;

    if (!this.isHost) {
      this.requestInitialBuffer();
    }
  }

  async handleText(op: any[], clientId: ClientId) {
    let _op, c, pid;

    switch (op[0]) {
      case protocol.OP_INS:
        [_op, c, pid] = op;
        const i = this.handleRemoteInsert(pid, c, clientId);
        break;
      case protocol.OP_DEL:
        // 🤦
        [_op, pid, c] = op;
        this.handleRemoteDelete(pid, c, clientId);
        break;
      default:
        Logger.log(`Received unhandled text operation ${op}`);
        break;
    }
  }

  async handleMessage(json: any[]) {
    protocol.validateMessage(json);
    switch (json[0]) {
      case MessageTypes.MSG_TEXT:
        const [_m, op, _b, clientId] = json;
        this.handleText(op, clientId);
        break;
      case MessageTypes.MSG_AVAILABLE:
        this.handleAvailableMessage(json);
        break;
      case MessageTypes.MSG_INITIAL:
        this.handleInitialMessage(json);
        break;
      default:
        window.showErrorMessage(`Received unhandled message ${JSON.stringify(json)}`);
        break;
    }
  }

  async setupGuest() {
    this.websocket.on('open', () => {
      Logger.log('Client connected');
      this.sendInfo();
    });

    this.websocket.on('message', (data: string) => {
      Logger.log(`received: ${data}`);
      const json = JSON.parse(data);
      // TODO: validate json against schema
      this.handleMessage(json);
    });

    this.websocket.on('error', (error: any) => {
      Logger.log(`WebSocket error: ${error}`);
    });

    this.websocket.on('close', () => {
      Logger.log('WebSocket connection closed');
    });
  }

  async setupHost() {
    throw new Error('Not implemented');
  }
}

export default Client;
/**
 * Sign-in state: one login token per fleet in VS Code's SecretStorage.
 */

import * as vscode from "vscode";
import type { Fleet } from "@bacloud/sdk";
import { currentFleet, type Cloud } from "./cloud.ts";

const secretKey = (fleet: Fleet) => `bacloud.token.${fleet}`;

export class Auth implements vscode.Disposable {
  private readonly secrets: vscode.SecretStorage;
  private readonly cloud: Cloud;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Fires when the token for the current fleet may have changed. */
  readonly onDidChange = this.changed.event;

  constructor(secrets: vscode.SecretStorage, cloud: Cloud) {
    this.secrets = secrets;
    this.cloud = cloud;
    this.subscriptions.push(
      this.changed,
      // Another window signing in or out shares the same storage.
      secrets.onDidChange((e) => {
        if (e.key === secretKey(currentFleet())) void this.refreshContext();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("bacloud.fleet")) void this.refreshContext();
      }),
    );
  }

  token(): Thenable<string | undefined> {
    return this.secrets.get(secretKey(currentFleet()));
  }

  async refreshContext(): Promise<void> {
    const signedIn = (await this.token()) !== undefined;
    await vscode.commands.executeCommand("setContext", "bacloud.signedIn", signedIn);
    this.changed.fire();
  }

  async signIn(): Promise<void> {
    const fleet = currentFleet();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Ballistica: waiting for sign-in in your browser…",
        cancellable: true,
      },
      async (_progress, cancel) => {
        let saving: Thenable<void> = Promise.resolve();
        await this.cloud.run(["signin"], {
          bearer: undefined,
          token: cancel,
          onLoginChange: (token) => {
            saving =
              token === undefined
                ? this.secrets.delete(secretKey(fleet))
                : this.secrets.store(secretKey(fleet), token);
          },
        });
        await saving;
      },
    );
    await this.refreshContext();
  }

  async signOut(): Promise<void> {
    const fleet = currentFleet();
    const bearer = await this.token();
    try {
      // Tell the server too, so the token stops working.
      await this.cloud.run(["signout"], { bearer });
    } finally {
      await this.secrets.delete(secretKey(fleet));
      await this.refreshContext();
    }
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }
}

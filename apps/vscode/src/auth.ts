/**
 * Sign-in state: one login token per fleet in VS Code's SecretStorage.
 *
 * Also registered as an authentication provider, so the signed-in
 * Ballistica account shows in VS Code's Accounts menu (and can be
 * signed out from there).
 */

import * as vscode from "vscode";
import { stripAnsi, type Fleet } from "@bacloud/sdk";
import { currentFleet, type Cloud } from "./cloud.ts";

export const AUTH_PROVIDER_ID = "ballistica";

const tokenKey = (fleet: Fleet) => `bacloud.token.${fleet}`;
const accountKey = (fleet: Fleet) => `bacloud.account.${fleet}`;

/** The account name the server prints, e.g. "Signed in as aryan02420." */
export function parseAccountName(output: string): string | undefined {
  return /signed in as\s+(\S+?)\.?\s*$/im.exec(stripAnsi(output))?.[1];
}

export class Auth implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly secrets: vscode.SecretStorage;
  private readonly cloud: Cloud;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly sessionsChanged =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Last session reported, to describe changes to VS Code. */
  private lastSession: vscode.AuthenticationSession | undefined;
  /** Fires when the token for the current fleet may have changed. */
  readonly onDidChange = this.changed.event;
  readonly onDidChangeSessions = this.sessionsChanged.event;

  constructor(secrets: vscode.SecretStorage, cloud: Cloud) {
    this.secrets = secrets;
    this.cloud = cloud;
    this.subscriptions.push(
      this.changed,
      this.sessionsChanged,
      vscode.authentication.registerAuthenticationProvider(AUTH_PROVIDER_ID, "Ballistica", this, {
        supportsMultipleAccounts: false,
      }),
      // Another window signing in or out shares the same storage.
      secrets.onDidChange((e) => {
        const fleet = currentFleet();
        if (e.key === tokenKey(fleet) || e.key === accountKey(fleet)) void this.refreshContext();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("bacloud.fleet")) void this.refreshContext();
      }),
    );
  }

  token(): Thenable<string | undefined> {
    return this.secrets.get(tokenKey(currentFleet()));
  }

  async refreshContext(): Promise<void> {
    const signedIn = (await this.token()) !== undefined;
    await vscode.commands.executeCommand("setContext", "bacloud.signedIn", signedIn);
    await this.announceSession();
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
        const { stdout } = await this.cloud.run(["signin"], {
          bearer: undefined,
          token: cancel,
          onLoginChange: (token) => {
            saving =
              token === undefined
                ? this.secrets.delete(tokenKey(fleet))
                : this.secrets.store(tokenKey(fleet), token);
          },
        });
        await saving;
        const account = parseAccountName(stdout);
        if (account) await this.secrets.store(accountKey(fleet), account);
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
      await this.secrets.delete(tokenKey(fleet));
      await this.secrets.delete(accountKey(fleet));
      await this.refreshContext();
    }
  }

  // ---------------------------------------------------------------- //
  // vscode.AuthenticationProvider: what the Accounts menu reads.

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    const session = await this.currentSession();
    return session ? [session] : [];
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    await this.signIn();
    const session = await this.currentSession();
    if (!session) throw new Error("Ballistica sign-in did not complete.");
    return session;
  }

  async removeSession(): Promise<void> {
    await this.signOut();
  }

  private async currentSession(): Promise<vscode.AuthenticationSession | undefined> {
    const fleet = currentFleet();
    const token = await this.secrets.get(tokenKey(fleet));
    if (token === undefined) return undefined;
    const name =
      (await this.secrets.get(accountKey(fleet))) ?? (await this.lookUpAccount(token, fleet));
    const label = `${name ?? "Ballistica account"}${fleet === "prod" ? "" : ` (${fleet})`}`;
    return {
      id: `${fleet}:${name ?? "unknown"}`,
      accessToken: token,
      account: { id: `${fleet}:${name ?? "unknown"}`, label },
      scopes: [],
    };
  }

  /** Signed in before account names were recorded: ask the server once. */
  private async lookUpAccount(token: string, fleet: Fleet): Promise<string | undefined> {
    try {
      const { stdout } = await this.cloud.run(["status"], { bearer: token });
      const name = parseAccountName(stdout);
      if (name) await this.secrets.store(accountKey(fleet), name);
      return name;
    } catch {
      return undefined;
    }
  }

  /** Tell VS Code (and so the Accounts menu) when the session changed. */
  private async announceSession(): Promise<void> {
    const before = this.lastSession;
    const after = await this.currentSession();
    this.lastSession = after;
    if (before?.id === after?.id && before?.accessToken === after?.accessToken) return;
    this.sessionsChanged.fire({
      added: after && !before ? [after] : [],
      removed: before && !after ? [before] : [],
      changed: before && after ? [after] : [],
    });
    // The Accounts menu lists providers an extension has asked for a
    // session; asking quietly makes our own sign-in appear there.
    if (after) {
      await vscode.authentication.getSession(AUTH_PROVIDER_ID, [], { silent: true });
    }
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }
}

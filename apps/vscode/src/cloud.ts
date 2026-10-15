/**
 * Runs bacloud commands from inside VS Code.
 *
 * Each operation opens its own session (connect → run → close), the
 * same lifetime as one `bacloud` CLI invocation.
 */

import { homedir } from "node:os";
import * as vscode from "vscode";
import {
  BacloudClient,
  stripAnsi,
  type BacloudHost,
  type Fleet,
  type RunResult,
} from "@bacloud/sdk";
import { nodeFileHost } from "@bacloud/sdk/node";

export function currentFleet(): Fleet {
  return vscode.workspace.getConfiguration("bacloud").get<Fleet>("fleet", "prod");
}

export interface RunOptions {
  bearer: string | undefined;
  cwd?: string;
  /** Called when the server signs in (token) or out (undefined). */
  onLoginChange?: (token: string | undefined) => void;
  /** Cancelling closes the session, which fails the running command. */
  token?: vscode.CancellationToken;
}

export interface CommandOutput extends RunResult {
  /** Everything the server printed to stdout, ANSI codes included. */
  stdout: string;
}

export class Cloud {
  private readonly log: vscode.LogOutputChannel;

  constructor(log: vscode.LogOutputChannel) {
    this.log = log;
  }

  async run(args: string[], options: RunOptions): Promise<CommandOutput> {
    let stdout = "";
    const host: BacloudHost = {
      stdout: (text) => {
        stdout += text;
        this.appendLines(text, "info");
      },
      stderr: (text) => this.appendLines(text, "warn"),
      prompt: async (message, { password }) => {
        const value = await vscode.window.showInputBox({
          prompt: stripAnsi(message).trim(),
          password,
          ignoreFocusOut: true,
        });
        if (value === undefined) throw new vscode.CancellationError();
        return value;
      },
      openUrl: (url) => {
        this.log.info(`Opening ${url}`);
        void vscode.env.openExternal(vscode.Uri.parse(url));
      },
      fs: nodeFileHost,
    };

    const trace = vscode.workspace.getConfiguration("bacloud").get<boolean>("trace", false);
    const client = await BacloudClient.connect({
      host,
      fleet: currentFleet(),
      bearer: options.bearer,
      onLoginChange: options.onLoginChange,
      log: trace ? (message) => this.log.debug(message) : undefined,
    });
    const cancel = options.token?.onCancellationRequested(() => {
      this.log.info("Cancelled; closing the session.");
      void client.close();
    });
    try {
      this.log.info(`bacloud ${args.join(" ")}`);
      const result = await client.run(args, { cwd: options.cwd ?? homedir() });
      return { ...result, stdout };
    } finally {
      cancel?.dispose();
      await client.close();
    }
  }

  private appendLines(text: string, level: "info" | "warn"): void {
    for (const line of stripAnsi(text).split("\n")) {
      if (line.trim()) this.log[level](line);
    }
  }
}

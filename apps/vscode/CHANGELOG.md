# Changelog

## 0.1.0

### New

- **Resolve conflicts in the merge editor.** When you and the cloud both changed a file, choose **Merge** to open VS Code's 3-way merge editor. It compares your last sync, the cloud version and your local copy. Then choose **Keep Local** to mark the conflict resolved.
- **See your changes in Source Control.** Each cloud workspace now shows up in the Source Control view. Files you added, changed or deleted since the last sync are listed there, and the badge counts them. Click a file to see what changed. Pull and Push are in the view's title bar. It works alongside git.
- **Change bars in the editor.** The gutter marks lines you changed since the last sync.
- **Local Changes view.** The Ballistica sidebar lists your unsynced changes under Current Workspace, with a Push button.
- **Account in the Accounts menu.** Your Ballistica account appears in VS Code's Accounts menu, and you can sign out from there.

## 0.0.1

First release.

- Sign in with your Ballistica account in the browser.
- Browse your cloud workspaces and clone one into a folder.
- Pull with a 3-way review: cloud changes are sorted into Incoming, Conflicts and Local only. Nothing is overwritten until you apply it.
- Push with a preview of your changes. If the cloud changed since your last sync, the extension offers to pull first.
- The status bar shows the workspace's sync status.

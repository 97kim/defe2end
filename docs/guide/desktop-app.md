# Desktop app

The desktop app runs scenarios on your own PC, opens a side browser for recording and inspecting pages, and hosts the AI chat and the local MCP server. It connects to your defE2End server.

Supported: macOS on Apple Silicon and Intel, Windows x64.

## Download

Get the installer from the GitHub Releases page of the version that matches your server:

- macOS Apple Silicon: `…-arm64.dmg`
- macOS Intel: `…-x64.dmg`
- Windows: `…-setup.exe` (x64)

Each release also has a `SHA256SUMS` file.

## Check the checksum

Compare the hash of the file you downloaded with its line in `SHA256SUMS`. They must match exactly.

macOS (Terminal):

```sh
shasum -a 256 ~/Downloads/defE2End-1.0.0-arm64.dmg
```

Windows (PowerShell):

```powershell
Get-FileHash $env:USERPROFILE\Downloads\defE2End-1.0.0-setup.exe -Algorithm SHA256
```

If the hash differs, delete the file and download it again. Don't install a file whose hash doesn't match.

## Install and first launch

The app is **not code-signed**. The first time you open it, your OS may block it. Use the normal way to allow one app; don't turn off OS security features.

**macOS**

1. Open the `.dmg` and drag defE2End to Applications.
2. Open defE2End. If macOS says it can't verify the developer, click **Done** (or **OK**).
3. Open **System Settings > Privacy & Security**. Near the bottom, next to the message about defE2End, click **Open Anyway** and confirm.

You only need to do this once per installed version.

**Windows**

1. Run the installer.
2. If Microsoft Defender SmartScreen shows "Windows protected your PC", click **More info**, check that the app name is the installer you downloaded, then click **Run anyway**.

**Managed computers.** Some company policies block unsigned apps entirely, and the steps above won't be offered. In that case ask your IT team; don't try to work around the policy.

## Connect to your server

On first launch the app asks for the server URL (the same URL as `BETTER_AUTH_URL`). Sign in as you do on the web. You can change the server later in the app settings; changing it signs you out.

Your server admin can require a minimum app version (`DESKTOP_MIN_VERSION`). An older app shows an update notice instead of connecting.

## Updates

The app does not update itself. It checks GitHub Releases when it starts and once a day, and tells you when a newer stable release exists (release candidates are not announced). To update, download the new installer and install it over the old one, checking its checksum as above.

To turn off the check, switch off the new-version notice in the app settings. Network failures during the check are ignored silently.

Keep the app close to your server version: a server supports the app of the same version and one version back.

## Uninstall

- macOS: quit the app and move it from Applications to the Trash.
- Windows: **Settings > Apps > Installed apps > defE2End > Uninstall**.

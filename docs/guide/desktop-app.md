# Desktop app

The desktop app runs scenarios on your own PC, opens a side browser for recording and inspecting pages, and hosts the AI chat and the local MCP server. It connects to your defE2End server.

Supported: macOS on Apple Silicon and Intel, Windows x64.

## Download

Get the installer from the GitHub Releases page of the version that matches your server:

- macOS Apple Silicon: `defE2End-1.0.0-arm64.dmg`
- macOS Intel: `defE2End-1.0.0-x64.dmg`
- Windows x64: `defE2End Setup 1.0.0.exe`

Each release also has `SHA256SUMS` (checksums of every release file), `IMAGE_DIGESTS.txt` (the digests of the three server images) and GitHub build provenance for the installers and images.

## Verify the file

Verify every installer before you open it: check its checksum, and if you have the GitHub CLI (`gh`), its provenance.

### Checksum

Compare the hash of the file you downloaded with its line in `SHA256SUMS`. They must match exactly.

macOS (Terminal):

```sh
cd ~/Downloads
shasum -a 256 defE2End-1.0.0-arm64.dmg
grep defE2End-1.0.0-arm64.dmg SHA256SUMS
```

Windows (PowerShell):

```powershell
Get-FileHash "$env:USERPROFILE\Downloads\defE2End Setup 1.0.0.exe" -Algorithm SHA256
```

If the hash differs, delete the file and download it again. Don't install a file whose hash doesn't match.

### Provenance

This proves the file was built by this repository's release workflow:

```sh
gh attestation verify defE2End-1.0.0-arm64.dmg --repo 97kim/defe2end
```

It must end with a success message. Server images can be checked the same way, by the digest listed in `IMAGE_DIGESTS.txt`:

```sh
gh attestation verify oci://ghcr.io/97kim/defe2end-web@sha256:… --repo 97kim/defe2end
```

`docker buildx imagetools inspect ghcr.io/97kim/defe2end-web:1.0.0` shows the digest the version tag points to; it must match the file.

## Install and first launch

The app is **not code-signed**. The first time you open it, your OS may block it.

**The steps below are only for a file you downloaded from the official GitHub Releases page and verified as above.** Never use them for a file from anywhere else or one that failed verification. They allow this one app; don't turn off OS security features.

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

On first launch the app asks for the server URL (the same URL as `BETTER_AUTH_URL`). Sign in as you do on the web. To change it later, use **Change server address…** in the same menu as below; changing it signs you out.

Your server admin can require a minimum app version (`DESKTOP_MIN_VERSION`). An older app shows an update notice instead of connecting.

## Updates

The app does not update itself. 60 seconds after it starts, and then once a day, it asks GitHub's public Releases API for the latest stable release and tells you when a newer one exists, with a link to the download page. Release candidates are not announced.

- The request carries no authentication, no server address and no user identifier. Like any request to a public API, it shows your IP address to GitHub.
- It times out after 5 seconds, never blocks runs, and failures are ignored silently.
- To turn it off, uncheck **Tell me about new versions** in the **defE2End** menu (macOS) or the **File** menu (Windows). You can do this within the first 60 seconds, before the first check.

To update, download the new installer, [verify it](#verify-the-file) and install it over the old one.

### Server compatibility

The app connects to a server of the same major version when the app's minor version is at most one behind the server's. For example, server 1.4 accepts app 1.3 and later 1.x apps. Whether a given run can go to the app is then decided by the features the app reports.

## Uninstall

- macOS: quit the app and move it from Applications to the Trash.
- Windows: **Settings > Apps > Installed apps > defE2End > Uninstall**.

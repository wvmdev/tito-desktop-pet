# Tito — desktop cat companion

Tito is an open-source desktop cat for Windows 10/11 (x64) and macOS on Apple silicon. The transparent cat stays above ordinary windows. Click Tito to open Chat and Settings, drag him to move him, and right-click the cat for **Hide Tito** or **Quit Tito**. To show a hidden pet on macOS, click Tito in the Dock. On Windows, launch Tito again from Start or its shortcut; the running app will show the pet.

## Download and install

Ready-to-install files are attached to the [latest GitHub release](https://github.com/wvmdev/tito-desktop-pet/releases/latest):

- **macOS (Apple silicon):** download `Tito-1.0.0-mac-arm64.dmg`, open it, and drag **Tito** into **Applications**.
- **Windows 10/11 (x64):** download `Tito-Setup-1.0.0-win-x64.exe` and run the installer. It creates Start Menu and desktop shortcuts. The portable ZIP is also available as `Tito-portable-1.0.0-win-x64.zip`.
- **Source:** download `Tito-source-1.0.0.zip`, or clone this repository.

The desktop builds are unsigned because no developer signing certificates are configured. Windows SmartScreen or macOS Gatekeeper may identify an unsigned build. Review the source and release checksums before installing, or build it yourself from source. The GitHub Actions workflow also builds native Windows and macOS packages.

## Build from source

Install [Node.js 24 or newer](https://nodejs.org/), then run these commands from the project folder:

```sh
npm ci
npm start
```

Build a package on its target operating system:

```sh
npm run dist:win   # Windows x64 installer and portable ZIP
npm run dist:mac   # macOS DMG for the Mac architecture in use
```

Each package uses Electron's native runtime. Tito stores API keys with Electron `safeStorage` (Windows DPAPI or the macOS Keychain).

## Connect an AI provider

Open **Settings**, choose OpenAI, Anthropic, Google Gemini, OpenRouter, or an OpenAI-compatible endpoint, then enter the model and API key. **Test** checks the selected key and model before saving. Custom endpoints must use HTTPS, except localhost for local servers.

Keys stay in the app's main process and are never returned to the renderer. Chat messages go only to the provider selected in Settings. Conversation history stays in memory for the current chat and is cleared with **New chat**. Provider API usage may incur charges under that provider's terms.

## Pet behavior

Tito's mood responds to local time, battery status when available, and Barcelona weather. Weather-dependent moods continue with the last fetched conditions while offline. After two idle minutes, each mood uses its selected frame loop. After five minutes Tito holds a resting frame. Moving the cursor over him wakes the normal three-frame animation. The mood priority and frame choices are documented in [Aura-animation-guide.svg](Aura-animation-guide.svg).

## Project contents

This repository contains the Electron source, sprite assets, animation guide, tests, lockfile, MIT license, and GitHub Actions workflow. Generated build folders are excluded from the source tree; downloadable installers and source archives are attached to GitHub Releases.

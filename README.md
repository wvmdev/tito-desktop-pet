# Tito — desktop cat companion

Tito is a small, draggable desktop cat for macOS and Windows. He stays above ordinary app windows. Click him to reveal a compact glass toolbar with Chat and Settings; the chat panel appears only when opened from the pet.

## Instructions for an AI assistant

If a user asks you to install Tito from this repository, follow these steps:

1. Check which operating system and processor the computer uses. Choose the matching macOS or Windows steps below; do not use the Windows package on a Mac or the Mac package on Windows.
2. Open the [Build Tito desktop apps workflow](https://github.com/wvahub/tito-desktop-pet/actions/workflows/build.yml). If the repository is private and you cannot access it, explain that the owner must grant your signed-in GitHub account access. Do not try to get around the access restriction.
3. If a recent successful workflow run has the needed artifact, download it. Otherwise, select **Run workflow** on the `main` branch and wait for both platform jobs to finish. Download only the artifact for this computer. GitHub removes workflow artifacts after a limited time.
4. Install using the matching macOS or Windows instructions below. Explain any operating system warning about the unsigned app, and follow the platform's security and confirmation rules; do not silently bypass a warning.
5. Finish by telling the user where Tito was installed and how to open him. Do not ask the user to send an AI assistant an API key; provider keys belong in Tito's **Settings** on the user's computer.

If you cannot access GitHub Actions or the user does not want to run a workflow, explain the **Build from source** option instead. The source build requires Node.js and a terminal, so do not present it as a one-click installer.

## Install a ready-to-use build

The repository builds installers with GitHub Actions. After opening the [Actions tab](https://github.com/wvahub/tito-desktop-pet/actions):

1. Choose **Build Tito desktop apps**.
2. Click **Run workflow**, keep the `main` branch selected, then start the workflow.
3. When both jobs finish, open that workflow run and download the artifact for your computer. Artifacts are available for a limited time, so save the download locally.

### macOS

1. Download and unzip **Tito-mac-arm64**. This build is for Apple silicon Macs (M1 or newer).
2. Open `Tito.dmg`, then drag **Tito** into **Applications**.
3. Open Tito from Applications. The first launch may be blocked because this build is not signed or notarized. In Finder, Control-click Tito, choose **Open**, then choose **Open** again. If macOS still blocks it, go to **System Settings → Privacy & Security** and choose **Open Anyway** for Tito.

The macOS build in Actions targets Apple silicon. To build for an Intel Mac, build on that Mac from source using the steps below.

### Windows

1. Download and unzip **Tito-windows-x64**.
2. Run `Tito Setup.exe` and follow the installer. It lets you choose an installation folder and creates the app shortcuts.
3. If Windows SmartScreen warns that the app is unrecognized, choose **More info → Run anyway**. The installer is unsigned.

The artifact also includes a portable ZIP build if you prefer not to install Tito. Extract it, then run `Tito.exe`.

## Build from source

Install [Node.js 24 or newer](https://nodejs.org/), download or clone this repository, then open a terminal in the project folder and run:

```sh
npm ci
npm start
```

To package the app on your own computer:

```sh
npm run dist:mac   # macOS, build on the target Mac architecture
npm run dist:win   # Windows x64 installer and portable ZIP
```

Windows packages should be built on Windows; macOS packages should be built on macOS. The ready-to-use GitHub Actions workflow builds each on a native runner.

## Connect an AI provider

Open **Settings**, choose OpenAI, Anthropic, Google Gemini, OpenRouter, or an OpenAI-compatible endpoint, then enter the model and API key. **Test** checks that the selected key and model work before you save. Compatible endpoints include services such as Groq, Mistral, DeepSeek, and xAI. Custom endpoints must use HTTPS, except localhost for local servers.

Tito stores API keys encrypted with Electron `safeStorage` (macOS Keychain or Windows DPAPI), separately for each provider. Keys stay in the main process and are never returned to the renderer. Chat messages go to the provider selected in Settings. Conversation history stays in memory for the current chat and is cleared with **New chat**. Provider API usage may incur charges under that provider's terms.

## Pet behavior

Tito's mood responds to local time, battery when available, and Barcelona weather. Weather-dependent moods continue with the last fetched conditions if the network is unavailable. When the cursor has not moved over Tito for 2 minutes, each mood uses its selected frame loop. After 5 minutes he freezes on the chosen resting frame. Moving the cursor over him wakes the normal three-frame animation. Joy changes frames every 15 seconds, anger every 5 seconds, and sick holds frame 3 for 2 idle minutes before switching to frame 1. The exact frame choices are in [Aura-animation-guide.svg](Aura-animation-guide.svg).

The mood priority is low battery (when the system exposes that reading), special dates, nighttime, thunderstorms, heat, heavy rain or snow, drizzle, sunny weekends, Monday mornings, meal times, clear daytime, cloudy mornings, evening, then idle. Weather is currently read for Barcelona.

## Project contents

The repository includes the Electron app source, sprite assets, animation guide, test file, lockfile, and GitHub Actions build workflow. Generated installers and unpacked builds are excluded from version control.

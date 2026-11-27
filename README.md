# Tito — desktop cat companion

A cat that lives on your desktop (macOS and Windows 11): walks on your windows, reacts to music and battery, and chats with the AI provider you choose.

**Download:** [latest release](https://github.com/wvmdev/tito-desktop-pet/releases/latest) · **Website:** https://titopet.netlify.app

- Mac: `Tito-*-mac.dmg` (first open: System Settings → Privacy & Security → Open Anyway)
- Windows 11: `Tito-Setup-*-x64.exe` (ARM PCs: `-arm64.exe`); SmartScreen: More info → Run anyway

## Build from source
```sh
npm ci && npm start
npm run dist:win   # Windows installers
npm run dist       # macOS dmg
```

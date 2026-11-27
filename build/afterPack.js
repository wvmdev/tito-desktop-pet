// electron-builder hook: brands the Windows exe (icon + version info) without needing Wine.
// It edits Tito.exe's resources with the pure-JS "resedit" library, so the taskbar, Start menu and
// Task Manager show Tito's cat instead of the default Electron icon, from any build machine.
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = require('resedit');
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const res = ResEdit.NtExecutableResource.from(exe);

  // Icon: replace the first icon group (Electron's) with ours.
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const id = groups.length ? groups[0].id : 101;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, ico.icons.map(i => i.data));

  // Version info shown in Task Manager and the file's Properties.
  const version = context.packager.appInfo.version;
  const infos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const vi = infos.length ? infos[0] : ResEdit.Resource.VersionInfo.createEmpty();
  const [maj, min, pat] = version.split('.').map(n => parseInt(n, 10) || 0);
  vi.setFileVersion(maj, min, pat, 0, 1033);
  vi.setProductVersion(maj, min, pat, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'Tito, your desktop cat', ProductName: 'Tito', CompanyName: 'Tito', InternalName: 'Tito',
    OriginalFilename: 'Tito.exe', LegalCopyright: 'MIT License',
  });
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
};

; Querii — Inno Setup Installer Script
; Builds a Windows installer that puts the app in Program Files
; and creates Start Menu + optional Desktop shortcut.

[Setup]
AppName=Querii
AppVersion=3.0-beta
AppPublisher=Heisenberg
AppPublisherURL=https://github.com/utkarsh-brainstorm/querii
DefaultDirName={autopf}\Querii
DefaultGroupName=Querii
OutputDir=dist
OutputBaseFilename=querii-windows-setup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=lowest
; App data lives in %APPDATA%\Querii — no installer access needed
UninstallDisplayIcon={app}\querii-windows.exe

[Files]
Source: "dist\querii-windows\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Querii"; Filename: "{app}\querii-windows.exe"
Name: "{autodesktop}\Querii"; Filename: "{app}\querii-windows.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"

[Run]
Filename: "{app}\querii-windows.exe"; Description: "Launch Querii now"; Flags: nowait postinstall skipifsilent

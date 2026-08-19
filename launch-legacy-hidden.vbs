Option Explicit

Dim shell, filesystem, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set filesystem = CreateObject("Scripting.FileSystemObject")

scriptPath = filesystem.BuildPath(filesystem.GetParentFolderName(WScript.ScriptFullName), "run.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """ -Ui legacy"

' Run the original Whispera renderer without a console window.
shell.Run command, 0, False

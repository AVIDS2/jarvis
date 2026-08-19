Option Explicit

Dim shell, filesystem, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set filesystem = CreateObject("Scripting.FileSystemObject")

scriptPath = filesystem.BuildPath(filesystem.GetParentFolderName(WScript.ScriptFullName), "run.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """ -Ui legacy"

' The production launcher keeps Whispera's native renderer on the audio path.
shell.Run command, 0, False

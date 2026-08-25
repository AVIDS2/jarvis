Option Explicit

Dim shell, filesystem, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set filesystem = CreateObject("Scripting.FileSystemObject")

scriptPath = filesystem.BuildPath(filesystem.GetParentFolderName(WScript.ScriptFullName), "scripts\jarvis-supervisor.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """ -Mode watch"

' The production launcher starts the local watchdog; it owns the native audio stack's recovery.
shell.Run command, 0, False

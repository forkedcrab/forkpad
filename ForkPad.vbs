' ForkPad launcher for Windows: runs server\start.js through wscript.exe, so no console
' window ever appears. start.js starts the hidden helper and opens the app window.
Option Explicit
Dim sh, fso, dir, node
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node"
sh.Run """" & node & """ """ & dir & "\server\start.js""", 0, False

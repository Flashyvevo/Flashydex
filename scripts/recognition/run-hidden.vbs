' Hidden launcher: wscript run-hidden.vbs <recognizer|tunnel> "<path to bash.exe>"
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 2 Then WScript.Quit 1
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\supervise.ps1"" -Name " & WScript.Arguments(0) & " -Bash """ & WScript.Arguments(1) & """"
sh.Run cmd, 0, False

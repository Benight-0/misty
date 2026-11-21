$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$backupRoot = Join-Path $projectRoot 'data\vm-backups'
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = Get-Acl -LiteralPath $backupRoot
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($account, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $backupRoot -AclObject $acl
$script = Join-Path $PSScriptRoot 'pull-vm-backup.ps1'
$powershell = Join-Path $PSHOME 'powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $script + '"'
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $projectRoot
# Convert the requested India-time schedule to the Windows computer's local time.
$indiaZone = [TimeZoneInfo]::FindSystemTimeZoneById('India Standard Time')
$indiaNow = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $indiaZone)
$indiaTime = [DateTime]::SpecifyKind($indiaNow.Date.AddHours(19), [DateTimeKind]::Unspecified)
$localTime = [TimeZoneInfo]::ConvertTimeFromUtc([TimeZoneInfo]::ConvertTimeToUtc($indiaTime, $indiaZone), [TimeZoneInfo]::Local)
$triggers = @((New-ScheduledTaskTrigger -Daily -At $localTime), (New-ScheduledTaskTrigger -AtLogOn -User $account))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Archival VM backup' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Copy and verify the newest Archival VM backup when this laptop is online.' -Force | Select-Object TaskName,State

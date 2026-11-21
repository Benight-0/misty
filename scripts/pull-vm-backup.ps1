param()
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$backupRoot = Join-Path $projectRoot 'data\vm-backups'
$sshConfig = Join-Path $projectRoot 'data\deployment\ssh_config'
$manifestTemp = Join-Path $backupRoot 'latest.json.partial'
$backupTemp = $null
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
try {
    & scp.exe -q -F $sshConfig 'archival-vm:/var/backups/archival/latest.json' $manifestTemp
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the VM backup manifest.' }
    $latest = Get-Content -LiteralPath $manifestTemp -Raw | ConvertFrom-Json
    if ($latest.version -ne 1 -or $latest.filename -notmatch '^archival-\d{8}T\d{6}Z\.tar\.gz$' -or
        $latest.sha256 -notmatch '^[a-f0-9]{64}$' -or $latest.bytes -le 0 -or $latest.bytes -gt 20GB) {
        throw 'Unexpected VM backup manifest.'
    }
    $destination = Join-Path $backupRoot $latest.filename
    if (Test-Path -LiteralPath $destination) {
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $latest.sha256) {
            throw 'An existing local backup failed its checksum; it was preserved for inspection.'
        }
    } else {
        $backupTemp = $destination + '.partial'
        & scp.exe -q -F $sshConfig ('archival-vm:/var/backups/archival/' + $latest.filename) $backupTemp
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy the VM backup.' }
        if ((Get-Item -LiteralPath $backupTemp).Length -ne $latest.bytes -or
            (Get-FileHash -LiteralPath $backupTemp -Algorithm SHA256).Hash -ne $latest.sha256) {
            throw 'The downloaded backup failed verification.'
        }
        Move-Item -LiteralPath $backupTemp -Destination $destination
        $backupTemp = $null
    }
    Move-Item -LiteralPath $manifestTemp -Destination (Join-Path $backupRoot 'latest.json') -Force
    $resolvedRoot = [IO.Path]::GetFullPath($backupRoot)
    $older = Get-ChildItem -LiteralPath $backupRoot -Filter 'archival-*.tar.gz' -File | Sort-Object Name -Descending | Select-Object -Skip 7
    foreach ($old in $older) {
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($old.FullName)) -ne $resolvedRoot -or
            $old.Name -notmatch '^archival-\d{8}T\d{6}Z\.tar\.gz$') { throw 'Unexpected backup retention path.' }
        Remove-Item -LiteralPath $old.FullName
    }
    $message = (Get-Date).ToUniversalTime().ToString('o') + ' Verified local VM backup: ' + $latest.filename
    $message | Set-Content -LiteralPath (Join-Path $backupRoot 'last-pull.log')
    Write-Output $message
} catch {
    ((Get-Date).ToUniversalTime().ToString('o') + ' Backup copy failed: ' + $_.Exception.Message) | Set-Content -LiteralPath (Join-Path $backupRoot 'last-pull.log')
    throw
} finally {
    if (Test-Path -LiteralPath $manifestTemp) { Remove-Item -LiteralPath $manifestTemp }
    if ($backupTemp -and (Test-Path -LiteralPath $backupTemp)) { Remove-Item -LiteralPath $backupTemp }
}

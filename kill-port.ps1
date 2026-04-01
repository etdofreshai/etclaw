$c = Get-NetTCPConnection -LocalPort 9224 -ErrorAction SilentlyContinue
if ($c) {
    $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Write-Host "Killed process(es) on port 9224"
    Start-Sleep -Seconds 2
}

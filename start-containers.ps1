$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerExe = if ($dockerCommand) { $dockerCommand.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe' }
if (-not (Test-Path -LiteralPath $dockerExe)) {
    $dockerExe = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
}
if (-not (Test-Path -LiteralPath $dockerExe)) { throw 'Docker Desktop CLI not found. Install and start Docker Desktop.' }
& $dockerExe info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Docker Engine is not available. Start Docker Desktop, wait for Engine running, and retry.' }
if (-not (Test-Path -LiteralPath '.env')) { throw 'Create .env from .env.example and set the secrets first.' }
& $dockerExe compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Compose configuration validation failed.' }
& $dockerExe compose up -d --build --wait --wait-timeout 300
if ($LASTEXITCODE -ne 0) { throw 'Container startup failed. Inspect: docker compose logs --tail 80' }
if (Test-Path -LiteralPath 'demo-seed\manifest.json') {
    & $dockerExe compose exec -T backend python -m app.import_demo /seed
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL import failed.' }
}
$capabilities = Invoke-RestMethod 'http://127.0.0.1:5174/api/workspaces/capabilities'
if ($capabilities.transcript_storage -ne 'postgresql') { throw 'Backend is not using PostgreSQL.' }
$saved = Invoke-RestMethod 'http://127.0.0.1:5174/api/workspaces/saved-transcripts'
$mis = Invoke-RestMethod -Method Post 'http://127.0.0.1:5174/api/integrations/mis/check'
if ($mis.status -ne 'connected') { throw 'Test MIS did not accept the API key.' }
& $dockerExe compose exec -T backend python -m app.verify_mis
if ($LASTEXITCODE -ne 0) { throw 'End-to-end MIS verification failed.' }
& $dockerExe compose ps
Write-Host ('Ready: http://127.0.0.1:5174 ; saved recordings: ' + $saved.Count)

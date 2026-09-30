@echo off
setlocal
cd /d "%~dp0"
set "DEMO_DOCKER=%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe"
if not exist "%DEMO_DOCKER%" set "DEMO_DOCKER=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
if not exist "%DEMO_DOCKER%" (
  echo Docker Desktop CLI was not found.
  pause
  exit /b 1
)
"%DEMO_DOCKER%" compose up -d --build --wait --wait-timeout 300
if errorlevel 1 goto failed
"%DEMO_DOCKER%" compose exec -T backend python -m app.import_demo /seed
if errorlevel 1 goto failed
"%DEMO_DOCKER%" compose exec -T backend python -m app.verify_mis
if errorlevel 1 goto failed
echo Ready: http://127.0.0.1:5174
pause
exit /b 0
:failed
echo Demo did not pass. Inspect: docker compose logs --tail 50 backend mock-mis db
pause
exit /b 1

@echo off
setlocal
cd /d "%~dp0"
set "MEDREP_DOCKER=%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe"
if not exist "%MEDREP_DOCKER%" set "MEDREP_DOCKER=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
if not exist "%MEDREP_DOCKER%" (
  echo Docker Desktop CLI was not found.
  pause
  exit /b 1
)
"%MEDREP_DOCKER%" compose build frontend
if errorlevel 1 (
  echo Frontend image build failed.
  pause
  exit /b 1
)
echo MedRep frontend image built. To run the full demo, launch start-demo.cmd.
pause

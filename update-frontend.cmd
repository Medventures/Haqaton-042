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
"%MEDREP_DOCKER%" compose up -d --build --no-deps frontend
if errorlevel 1 (
  echo Frontend update failed. See the error above.
  pause
  exit /b 1
)
echo Ready: http://127.0.0.1:5174/
echo Reload the browser with Ctrl+F5 to load the new Demo and Platform buttons.
pause

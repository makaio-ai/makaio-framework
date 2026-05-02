@echo off
REM Windows launcher for the Makaio CLI.
REM
REM Sets ELECTRON_RUN_AS_NODE=1 and runs the Electron binary with the
REM bundled cli.mjs entry point. All args are passed through.
REM
REM Added to PATH by the NSIS installer.

if not defined MAKAIO_APP set "MAKAIO_APP=%LOCALAPPDATA%\Programs\Makaio"

if not exist "%MAKAIO_APP%\Makaio.exe" (
  echo error: Makaio not found at %MAKAIO_APP% >&2
  echo Install Makaio or set MAKAIO_APP to the correct path. >&2
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE=1"
"%MAKAIO_APP%\Makaio.exe" "%MAKAIO_APP%\resources\app.asar\dist\cli.mjs" %*

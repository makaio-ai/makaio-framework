@echo off
REM Windows launcher for the Makaio CLI.
REM
REM Runs the standalone Bun binary shipped with the Makaio distribution
REM with the bundled cli.mjs entry point. All args are passed through.
REM
REM Added to PATH by the NSIS installer.

if not defined MAKAIO_APP set "MAKAIO_APP=%LOCALAPPDATA%\Programs\Makaio"

if not exist "%MAKAIO_APP%\bin\bun.exe" (
  echo error: Makaio not found at %MAKAIO_APP% >&2
  exit /b 1
)

"%MAKAIO_APP%\bin\bun.exe" "%MAKAIO_APP%\Resources\app\dist\cli.mjs" %*

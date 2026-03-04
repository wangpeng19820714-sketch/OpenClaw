@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"

pushd "%REPO_ROOT%" >nul 2>&1
if errorlevel 1 (
  echo [start.bat] ERROR: failed to enter repo root: %REPO_ROOT%
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [start.bat] ERROR: node not found in PATH.
  popd >nul
  exit /b 1
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo [start.bat] ERROR: pnpm not found in PATH.
  popd >nul
  exit /b 1
)

pnpm run start:server
if not errorlevel 1 goto done

echo [start.bat] pnpm run start:server failed; retrying with Windows-compatible env syntax.
set "OPENCLAW_CONFIG_PATH=configs/openclaw.json"
node scripts/run-node.mjs gateway --port 18789

:done
set "EXIT_CODE=%ERRORLEVEL%"
popd >nul
exit /b %EXIT_CODE%

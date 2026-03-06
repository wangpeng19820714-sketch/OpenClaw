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

if not exist "%REPO_ROOT%\\node_modules" (
  echo [start.bat] node_modules missing; running pnpm install first.
  pnpm install
  if errorlevel 1 (
    echo [start.bat] ERROR: pnpm install failed.
    popd >nul
    exit /b 1
  )
)

set "OPENCLAW_CONFIG_PATH=configs/openclaw.json"
set "OPENCLAW_CLI=%USERPROFILE%\\.openclaw\\bootstrap\\npm-global\\openclaw.cmd"
if not exist "%OPENCLAW_CLI%" (
  for /f "delims=" %%P in ('where openclaw 2^>nul') do (
    set "OPENCLAW_CLI=%%P"
    goto :openclaw_found
  )
  echo [start.bat] ERROR: openclaw CLI not found. Install it or add to PATH.
  popd >nul
  exit /b 1
)
:openclaw_found

if /I "%OPENCLAW_OAUTH_SKIP%"=="1" goto :start_gateway

set "OPENCLAW_OAUTH_PROVIDERS=%OPENCLAW_OAUTH_PROVIDERS%"
if "%OPENCLAW_OAUTH_PROVIDERS%"=="" goto :start_gateway

echo [start.bat] Checking OAuth sessions for %OPENCLAW_OAUTH_PROVIDERS%.
powershell -NoProfile -Command ^
  "$openclaw='%OPENCLAW_CLI%';" ^
  "$status=& $openclaw models status --json | ConvertFrom-Json;" ^
  "$providers='%OPENCLAW_OAUTH_PROVIDERS%'.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' };" ^
  "foreach($p in $providers){" ^
  "  $prov=$status.auth.oauth.providers | Where-Object { $_.provider -eq $p };" ^
  "  if(-not $prov -or $prov.status -ne 'ok'){" ^
  "    Write-Host \"[start.bat] OAuth missing for $p; starting login...\";" ^
  "    & $openclaw models auth login --provider $p;" ^
  "    if($LASTEXITCODE -ne 0){ exit $LASTEXITCODE }" ^
  "  }" ^
  "}"
if errorlevel 1 (
  echo [start.bat] ERROR: OAuth login failed.
  popd >nul
  exit /b 1
)

:start_gateway
echo [start.bat] Starting gateway with Windows-compatible env syntax.
node scripts/run-node.mjs gateway --port 18789

:done
set "EXIT_CODE=%ERRORLEVEL%"
popd >nul
exit /b %EXIT_CODE%

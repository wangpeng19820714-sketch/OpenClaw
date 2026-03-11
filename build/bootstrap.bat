@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem Windows bootstrap helper for OpenClaw daemon lifecycle.
rem Default action is deploy-only (install + configure + stop), not start.

set "REQUIRED_NODE_MAJOR=22"
set "DEFAULT_PORT=18789"
set "DEFAULT_OPENCLAW_VERSION=2026.3.2"

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"
set "DEFAULT_CONFIG_PATH=%REPO_ROOT%\configs\openclaw.json"
set "SETUP_MEM0_SCRIPT=%REPO_ROOT%\scripts\setup-mem0.bat"

if not defined OPENCLAW_CONFIG_PATH if exist "%DEFAULT_CONFIG_PATH%" (
  set "OPENCLAW_CONFIG_PATH=%DEFAULT_CONFIG_PATH%"
)

if defined OPENCLAW_ENV_FILE (
  set "ENV_FILE=%OPENCLAW_ENV_FILE%"
) else (
  set "ENV_FILE=%REPO_ROOT%\.env"
)

if defined OPENCLAW_STATE_DIR (
  set "STATE_DIR=%OPENCLAW_STATE_DIR%"
) else (
  set "STATE_DIR=%USERPROFILE%\.openclaw"
)

if defined OPENCLAW_LOG_PREFIX (
  set "OPENCLAW_LOG_PREFIX=%OPENCLAW_LOG_PREFIX%"
) else (
  set "OPENCLAW_LOG_PREFIX=gateway"
)

if defined OPENCLAW_INSTALL_ROOT (
  set "INSTALL_ROOT=%OPENCLAW_INSTALL_ROOT%"
) else (
  set "INSTALL_ROOT=%USERPROFILE%\.openclaw\bootstrap"
)

if defined OPENCLAW_NPM_PREFIX (
  set "NPM_PREFIX=%OPENCLAW_NPM_PREFIX%"
) else (
  set "NPM_PREFIX=%INSTALL_ROOT%\npm-global"
)

if defined OPENCLAW_NPM_SPEC (
  set "OPENCLAW_NPM_SPEC=%OPENCLAW_NPM_SPEC%"
) else (
  set "OPENCLAW_NPM_SPEC=openclaw@%DEFAULT_OPENCLAW_VERSION%"
)

if defined OPENCLAW_BIN (
  set "OPENCLAW_BIN=%OPENCLAW_BIN%"
) else (
  set "OPENCLAW_BIN=%NPM_PREFIX%\openclaw.cmd"
)

if defined OPENCLAW_GEMINI_BIN (
  set "GEMINI_BIN=%OPENCLAW_GEMINI_BIN%"
) else (
  set "GEMINI_BIN="
)

if defined OPENCLAW_GEMINI_CLI_NPM_SPEC (
  set "GEMINI_CLI_NPM_SPEC=%OPENCLAW_GEMINI_CLI_NPM_SPEC%"
) else (
  set "GEMINI_CLI_NPM_SPEC=@google/gemini-cli"
)

if defined OPENCLAW_GATEWAY_PORT (
  set "GATEWAY_PORT=%OPENCLAW_GATEWAY_PORT%"
) else (
  set "GATEWAY_PORT=%DEFAULT_PORT%"
)

if defined OPENCLAW_MEM0_BOOTSTRAP_MODE (
  set "OPENCLAW_MEM0_BOOTSTRAP_MODE=%OPENCLAW_MEM0_BOOTSTRAP_MODE%"
) else (
  set "OPENCLAW_MEM0_BOOTSTRAP_MODE=auto"
)

call :main %*
exit /b %ERRORLEVEL%

:main
call :refresh_runtime_paths_
call :ensure_log_dir || exit /b 1

set "COMMAND=%~1"
if not defined COMMAND set "COMMAND=deploy"
call :log "COMMAND=%COMMAND%"

if /I "%COMMAND%"=="deploy" (
  call :cmd_deploy
  exit /b %ERRORLEVEL%
)
if /I "%COMMAND%"=="start" (
  call :cmd_start
  exit /b %ERRORLEVEL%
)
if /I "%COMMAND%"=="stop" (
  call :cmd_stop
  exit /b %ERRORLEVEL%
)
if /I "%COMMAND%"=="status" (
  call :cmd_status
  exit /b %ERRORLEVEL%
)
if /I "%COMMAND%"=="logs" (
  shift
  call :cmd_logs %*
  exit /b %ERRORLEVEL%
)
if /I "%COMMAND%"=="health" (
  call :cmd_health
  exit /b %ERRORLEVEL%
)
if /I "%COMMAND%"=="update" (
  call :cmd_update
  exit /b %ERRORLEVEL%
)
if /I "%COMMAND%"=="-h" (
  call :usage
  exit /b 0
)
if /I "%COMMAND%"=="--help" (
  call :usage
  exit /b 0
)
if /I "%COMMAND%"=="help" (
  call :usage
  exit /b 0
)

call :usage
call :die "Unknown command: %COMMAND%"
exit /b 1

:now
set "NOW_TIME=%time: =0%"
set "NOW_TS=%date% %NOW_TIME:~0,8%"
exit /b 0

:refresh_runtime_paths_
if defined OPENCLAW_STATE_DIR (
  set "STATE_DIR=%OPENCLAW_STATE_DIR%"
) else (
  set "STATE_DIR=%USERPROFILE%\.openclaw"
)
if defined OPENCLAW_LOG_PREFIX (
  set "OPENCLAW_LOG_PREFIX=%OPENCLAW_LOG_PREFIX%"
) else (
  set "OPENCLAW_LOG_PREFIX=gateway"
)
if defined OPENCLAW_GATEWAY_PORT (
  set "GATEWAY_PORT=%OPENCLAW_GATEWAY_PORT%"
) else (
  set "GATEWAY_PORT=%DEFAULT_PORT%"
)
set "BOOTSTRAP_LOG_FILE=%STATE_DIR%\logs\bootstrap.log"
set "GATEWAY_STDOUT_LOG=%STATE_DIR%\logs\%OPENCLAW_LOG_PREFIX%.log"
set "GATEWAY_STDERR_LOG=%STATE_DIR%\logs\%OPENCLAW_LOG_PREFIX%.err.log"
exit /b 0

:ensure_log_dir
if not exist "%STATE_DIR%\logs" mkdir "%STATE_DIR%\logs" >nul 2>&1
if not exist "%STATE_DIR%\logs" (
  call :die "Failed to create log directory: %STATE_DIR%\logs"
  exit /b 1
)
if not exist "%BOOTSTRAP_LOG_FILE%" type nul > "%BOOTSTRAP_LOG_FILE%" 2>nul
exit /b 0

:log
call :now
set "LOG_LINE=[%NOW_TS%] %~1"
echo %LOG_LINE%
if defined BOOTSTRAP_LOG_FILE >> "%BOOTSTRAP_LOG_FILE%" echo %LOG_LINE%
exit /b 0

:die
call :log "ERROR: %~1"
exit /b 1

:resolve_openclaw_bin_path
if defined OPENCLAW_BIN if exist "%OPENCLAW_BIN%" exit /b 0
if exist "%NPM_PREFIX%\openclaw.cmd" (
  set "OPENCLAW_BIN=%NPM_PREFIX%\openclaw.cmd"
  exit /b 0
)
if exist "%NPM_PREFIX%\bin\openclaw.cmd" (
  set "OPENCLAW_BIN=%NPM_PREFIX%\bin\openclaw.cmd"
  exit /b 0
)
if exist "%NPM_PREFIX%\node_modules\.bin\openclaw.cmd" (
  set "OPENCLAW_BIN=%NPM_PREFIX%\node_modules\.bin\openclaw.cmd"
  exit /b 0
)
exit /b 1

:resolve_gemini_bin_path
if defined GEMINI_BIN if exist "%GEMINI_BIN%" exit /b 0
for /f "delims=" %%P in ('where gemini 2^>nul') do (
  set "GEMINI_BIN=%%P"
  exit /b 0
)
if exist "%NPM_PREFIX%\gemini.cmd" (
  set "GEMINI_BIN=%NPM_PREFIX%\gemini.cmd"
  exit /b 0
)
if exist "%NPM_PREFIX%\bin\gemini.cmd" (
  set "GEMINI_BIN=%NPM_PREFIX%\bin\gemini.cmd"
  exit /b 0
)
if exist "%NPM_PREFIX%\node_modules\.bin\gemini.cmd" (
  set "GEMINI_BIN=%NPM_PREFIX%\node_modules\.bin\gemini.cmd"
  exit /b 0
)
exit /b 1

:run_quiet
set "RUN_DESC=%~1"
shift
call :log "%RUN_DESC%"
if "%~1"=="" (
  call :die "No command provided for: %RUN_DESC%"
  exit /b 1
)
call :log "Command executable: %~1"
call %1 %2 %3 %4 %5 %6 %7 %8 %9 >> "%BOOTSTRAP_LOG_FILE%" 2>&1
if errorlevel 1 (
  call :log "Command failed. Recent bootstrap log:"
  powershell -NoProfile -Command "if ^(Test-Path '%BOOTSTRAP_LOG_FILE%'^) { Get-Content -Path '%BOOTSTRAP_LOG_FILE%' -Tail 40 }" 2>nul
  call :die "%RUN_DESC% failed"
  exit /b 1
)
exit /b 0

:run_soft
set "RUN_DESC=%~1"
shift
call :log "%RUN_DESC%"
if "%~1"=="" (
  call :log "Skip (no command): %RUN_DESC%"
  exit /b 0
)
call :log "Command executable: %~1"
call %1 %2 %3 %4 %5 %6 %7 %8 %9 >> "%BOOTSTRAP_LOG_FILE%" 2>&1
if errorlevel 1 (
  call :log "Skip (non-fatal): %RUN_DESC%"
  exit /b 0
)
exit /b 0

:require_node_and_npm
where node >nul 2>&1 || (
  call :die "node is required (Node ^>= %REQUIRED_NODE_MAJOR%)."
  exit /b 1
)
where npm >nul 2>&1 || (
  call :die "npm is required."
  exit /b 1
)

set "NODE_VERSION="
for /f "delims=" %%V in ('node -p "process.versions.node" 2^>NUL') do set "NODE_VERSION=%%V"
if not defined NODE_VERSION (
  call :die "Unable to detect Node version."
  exit /b 1
)

for /f "tokens=1 delims=." %%M in ("%NODE_VERSION%") do set "NODE_MAJOR=%%M"
echo %NODE_MAJOR%| findstr /R "^[0-9][0-9]*$" >nul || (
  call :die "Unexpected Node version format: %NODE_VERSION%"
  exit /b 1
)

if %NODE_MAJOR% LSS %REQUIRED_NODE_MAJOR% (
  call :die "Node %NODE_VERSION% is too old. Need Node ^>= %REQUIRED_NODE_MAJOR%."
  exit /b 1
)
exit /b 0

:load_env_file
if not exist "%ENV_FILE%" goto load_env_file_missing

set "ENV_TMP=%TEMP%\openclaw-env-%RANDOM%%RANDOM%.txt"
powershell -NoProfile -Command "$path = $env:ENV_FILE; $out = $env:ENV_TMP; $lines = Get-Content -LiteralPath $path; $outLines = New-Object System.Collections.Generic.List[string]; foreach ($raw in $lines) { $line = $raw.Trim(); if (-not $line) { continue }; if ($line.StartsWith('#')) { continue }; $eq = $line.IndexOf('='); if ($eq -lt 1) { continue }; $key = $line.Substring(0, $eq).Trim(); $val = $line.Substring($eq + 1).Trim(); if ($val.Length -ge 2) { $first = $val[0]; $last = $val[$val.Length - 1]; if (($first -eq [char]34 -and $last -eq [char]34) -or ($first -eq [char]39 -and $last -eq [char]39)) { $val = $val.Substring(1, $val.Length - 2) } }; $outLines.Add($key + '=' + $val) }; Set-Content -LiteralPath $out -Value $outLines -Encoding UTF8"
if errorlevel 1 goto load_env_file_fail
if not exist "%ENV_TMP%" goto load_env_file_fail
for /f "usebackq delims=" %%L in ("%ENV_TMP%") do set "%%L"
if exist "%ENV_TMP%" del /f /q "%ENV_TMP%" >nul 2>&1

call :log "Loaded environment from %ENV_FILE%"
call :refresh_runtime_paths_
call :ensure_log_dir || exit /b 1
exit /b 0

:load_env_file_missing
call :log "No .env found at %ENV_FILE%; continuing with current environment."
call :refresh_runtime_paths_
call :ensure_log_dir || exit /b 1
exit /b 0

:load_env_file_fail
call :die "Failed to parse .env via PowerShell"
exit /b 1

:sync_env_to_state_dir
set "TARGET_ENV=%STATE_DIR%\.env"
if not exist "%STATE_DIR%" mkdir "%STATE_DIR%" >nul 2>&1

if not exist "%ENV_FILE%" (
  call :log "Skip syncing .env to state dir: source file not found (%ENV_FILE%)."
  exit /b 0
)

if exist "%TARGET_ENV%" (
  fc /b "%ENV_FILE%" "%TARGET_ENV%" >nul 2>&1
  if not errorlevel 1 (
    call :log "State .env already up to date (%TARGET_ENV%)."
    exit /b 0
  )
)

copy /y "%ENV_FILE%" "%TARGET_ENV%" >nul 2>&1 || (
  call :die "Failed to sync .env to %TARGET_ENV%"
  exit /b 1
)
call :log "Synced .env to %TARGET_ENV% (for daemon runtime)."
exit /b 0

:extract_expected_version_from_spec
set "EXPECTED_VERSION="
for /f "tokens=2 delims=@" %%V in ("%OPENCLAW_NPM_SPEC%") do set "EXPECTED_VERSION=%%V"
exit /b 0

:read_openclaw_version
set "INSTALLED_VERSION="
set "OPENCLAW_VERSION_TMP=%TEMP%\openclaw-version-%RANDOM%%RANDOM%.txt"
call "%OPENCLAW_BIN%" --version > "%OPENCLAW_VERSION_TMP%" 2>nul
if errorlevel 1 (
  if exist "%OPENCLAW_VERSION_TMP%" del /f /q "%OPENCLAW_VERSION_TMP%" >nul 2>&1
  exit /b 1
)
for /f "usebackq delims=" %%V in ("%OPENCLAW_VERSION_TMP%") do (
  if not defined INSTALLED_VERSION set "INSTALLED_VERSION=%%V"
)
if exist "%OPENCLAW_VERSION_TMP%" del /f /q "%OPENCLAW_VERSION_TMP%" >nul 2>&1
if not defined INSTALLED_VERSION exit /b 1
exit /b 0

:ensure_openclaw_installed
if not exist "%NPM_PREFIX%" mkdir "%NPM_PREFIX%" >nul 2>&1

call :extract_expected_version_from_spec

call :resolve_openclaw_bin_path
if errorlevel 1 goto ensure_openclaw_install_needed

call :read_openclaw_version
if errorlevel 1 goto ensure_openclaw_install_needed

if not defined EXPECTED_VERSION (
  call :log "OpenClaw CLI found at %OPENCLAW_BIN%."
  exit /b 0
)

echo %INSTALLED_VERSION% | findstr /C:"%EXPECTED_VERSION%" >nul 2>&1
if not errorlevel 1 (
  call :log "OpenClaw CLI already matches version %EXPECTED_VERSION%."
  exit /b 0
)

call :log "OpenClaw CLI version mismatch (have: %INSTALLED_VERSION%, want: %EXPECTED_VERSION%)."

:ensure_openclaw_install_needed

call :log "NPM_PREFIX=[%NPM_PREFIX%]"
call :run_quiet "Installing %OPENCLAW_NPM_SPEC% into %NPM_PREFIX%" npm install -g --prefix "%NPM_PREFIX%" --omit=dev --no-audit --no-fund %OPENCLAW_NPM_SPEC% || exit /b 1
call :resolve_openclaw_bin_path || (
  call :die "OpenClaw binary not found after install under %NPM_PREFIX%"
  exit /b 1
)
call :log "OpenClaw CLI installed at %OPENCLAW_BIN%."
exit /b 0

:update_openclaw
call :run_quiet "Updating %OPENCLAW_NPM_SPEC%" npm install -g --prefix "%NPM_PREFIX%" --omit=dev --no-audit --no-fund %OPENCLAW_NPM_SPEC% || exit /b 1
call :resolve_openclaw_bin_path || (
  call :die "OpenClaw binary not found after update under %NPM_PREFIX%"
  exit /b 1
)
exit /b 0

:ensure_gemini_cli_installed
call :resolve_gemini_bin_path
if not errorlevel 1 (
  call :log "Gemini CLI found at %GEMINI_BIN%."
  exit /b 0
)

if not exist "%NPM_PREFIX%" mkdir "%NPM_PREFIX%" >nul 2>&1
call :run_quiet "Installing %GEMINI_CLI_NPM_SPEC% into %NPM_PREFIX%" npm install -g --prefix "%NPM_PREFIX%" --no-audit --no-fund %GEMINI_CLI_NPM_SPEC% || exit /b 1
call :resolve_gemini_bin_path || (
  call :die "Gemini CLI not found after installation."
  exit /b 1
)
call :log "Gemini CLI ready at %GEMINI_BIN%."
exit /b 0

:configure_gateway_defaults
call :run_quiet "Setting gateway.mode=local" "%OPENCLAW_BIN%" config set gateway.mode local || exit /b 1
call :run_quiet "Setting gateway.port=%GATEWAY_PORT%" "%OPENCLAW_BIN%" config set gateway.port %GATEWAY_PORT% || exit /b 1
exit /b 0

:disable_local_plugins
if /I "%OPENCLAW_KEEP_LOCAL_PLUGINS%"=="1" (
  call :log "Keeping local plugins per OPENCLAW_KEEP_LOCAL_PLUGINS=1."
  exit /b 0
)
call :run_soft "Clearing local plugin paths" "%OPENCLAW_BIN%" config unset plugins.load.paths
call :run_soft "Clearing local plugin installs" "%OPENCLAW_BIN%" config unset plugins.installs
exit /b 0

:install_gateway_daemon
call :log "Installing gateway daemon (port %GATEWAY_PORT%)"
call :log "Command executable: %OPENCLAW_BIN%"
call "%OPENCLAW_BIN%" gateway install --force --port %GATEWAY_PORT% >> "%BOOTSTRAP_LOG_FILE%" 2>&1
if not errorlevel 1 exit /b 0

schtasks /Query /TN "OpenClaw Gateway" >nul 2>&1
if not errorlevel 1 (
  call :log "Gateway scheduled task already exists; keeping the current install."
  exit /b 0
)

call :log "Command failed. Recent bootstrap log:"
powershell -NoProfile -Command "if ^(Test-Path '%BOOTSTRAP_LOG_FILE%'^) { Get-Content -Path '%BOOTSTRAP_LOG_FILE%' -Tail 40 }" 2>nul
call :die "Installing gateway daemon (port %GATEWAY_PORT%) failed"
exit /b 1
exit /b 0

:config_uses_mem0_bridge
if not defined OPENCLAW_CONFIG_PATH exit /b 1
if not exist "%OPENCLAW_CONFIG_PATH%" exit /b 1

node -e "const fs = require('fs'); const p = process.argv[1]; const raw = fs.readFileSync(p, 'utf8'); const cfg = JSON.parse(raw); const paths = cfg?.plugins?.load?.paths; const slot = cfg?.plugins?.slots?.memory; const enabled = cfg?.plugins?.entries?.mem0?.enabled; const usesBridge = Array.isArray(paths) && paths.some((entry) => typeof entry === 'string' && entry.includes('mem0-openclaw')); process.exit(usesBridge || slot === 'mem0' || enabled === true ? 0 : 1);" "%OPENCLAW_CONFIG_PATH%" >nul 2>&1
exit /b %ERRORLEVEL%

:should_bootstrap_mem0
if /I "%OPENCLAW_MEM0_BOOTSTRAP_MODE%"=="always" exit /b 0
if /I "%OPENCLAW_MEM0_BOOTSTRAP_MODE%"=="never" exit /b 1
if /I "%OPENCLAW_MEM0_BOOTSTRAP_MODE%"=="auto" (
  call :config_uses_mem0_bridge
  exit /b %ERRORLEVEL%
)
call :die "Unsupported OPENCLAW_MEM0_BOOTSTRAP_MODE: %OPENCLAW_MEM0_BOOTSTRAP_MODE% (expected auto|always|never)"
exit /b 2

:ensure_mem0_deployed_if_needed
if not exist "%SETUP_MEM0_SCRIPT%" (
  call :log "Skip Mem0 bootstrap: script not found (%SETUP_MEM0_SCRIPT%)."
  exit /b 0
)

call :should_bootstrap_mem0
if errorlevel 2 exit /b 1
if errorlevel 1 (
  call :log "Skip Mem0 bootstrap (mode=%OPENCLAW_MEM0_BOOTSTRAP_MODE%)."
  exit /b 0
)

call :run_quiet "Deploying external Mem0 stack" "%SETUP_MEM0_SCRIPT%" || exit /b 1
exit /b 0

:provider_needs_gemini_cli
if /I "%~1"=="google-gemini-cli" exit /b 0
exit /b 1

:provider_oauth_status
set "OAUTH_PROVIDER=%~1"
set "OAUTH_STATUS="
set "OAUTH_PS1=%TEMP%\openclaw-oauth-status-%RANDOM%%RANDOM%.ps1"
set "OAUTH_STATUS_TMP=%TEMP%\openclaw-model-status-%RANDOM%%RANDOM%.txt"
set "OAUTH_RESULT_TMP=%TEMP%\openclaw-oauth-status-%RANDOM%%RANDOM%.txt"
call "%OPENCLAW_BIN%" models status --json > "%OAUTH_STATUS_TMP%" 2>> "%BOOTSTRAP_LOG_FILE%"
if errorlevel 1 (
  if exist "%OAUTH_PS1%" del /f /q "%OAUTH_PS1%" >nul 2>&1
  if exist "%OAUTH_STATUS_TMP%" del /f /q "%OAUTH_STATUS_TMP%" >nul 2>&1
  if exist "%OAUTH_RESULT_TMP%" del /f /q "%OAUTH_RESULT_TMP%" >nul 2>&1
  exit /b 1
)
> "%OAUTH_PS1%" echo $file = $env:OAUTH_STATUS_TMP
>> "%OAUTH_PS1%" echo $provider = $env:OAUTH_PROVIDER
>> "%OAUTH_PS1%" echo $text = Get-Content -Raw -LiteralPath $file
>> "%OAUTH_PS1%" echo $start = $text.IndexOf('{')
>> "%OAUTH_PS1%" echo if ($start -lt 0) { exit 2 }
>> "%OAUTH_PS1%" echo $payload = $text.Substring($start^) ^| ConvertFrom-Json
>> "%OAUTH_PS1%" echo $entry = @($payload.auth.oauth.providers^) ^| Where-Object { $_.provider -eq $provider } ^| Select-Object -First 1
>> "%OAUTH_PS1%" echo if ($null -eq $entry) { 'missing' } else { $entry.status }
powershell -NoProfile -ExecutionPolicy Bypass -File "%OAUTH_PS1%" > "%OAUTH_RESULT_TMP%" 2>> "%BOOTSTRAP_LOG_FILE%"
if errorlevel 1 (
  if exist "%OAUTH_PS1%" del /f /q "%OAUTH_PS1%" >nul 2>&1
  if exist "%OAUTH_STATUS_TMP%" del /f /q "%OAUTH_STATUS_TMP%" >nul 2>&1
  if exist "%OAUTH_RESULT_TMP%" del /f /q "%OAUTH_RESULT_TMP%" >nul 2>&1
  exit /b 1
)
for /f "usebackq delims=" %%S in ("%OAUTH_RESULT_TMP%") do (
  if not defined OAUTH_STATUS set "OAUTH_STATUS=%%S"
)
if exist "%OAUTH_PS1%" del /f /q "%OAUTH_PS1%" >nul 2>&1
if exist "%OAUTH_STATUS_TMP%" del /f /q "%OAUTH_STATUS_TMP%" >nul 2>&1
if exist "%OAUTH_RESULT_TMP%" del /f /q "%OAUTH_RESULT_TMP%" >nul 2>&1
if not defined OAUTH_STATUS exit /b 1
exit /b 0

:enable_google_gemini_cli_auth_plugin
call :run_quiet "Enabling google-gemini-cli-auth plugin" "%OPENCLAW_BIN%" plugins enable google-gemini-cli-auth || exit /b 1
exit /b 0

:ensure_provider_oauth_ready
set "PROVIDER_NAME=%~1"
call :provider_needs_gemini_cli "%PROVIDER_NAME%"
if not errorlevel 1 (
  call :ensure_gemini_cli_installed || exit /b 1
  call :enable_google_gemini_cli_auth_plugin || exit /b 1
)

call :provider_oauth_status "%PROVIDER_NAME%" || (
  call :die "Failed to inspect OAuth status for %PROVIDER_NAME%."
  exit /b 1
)
if /I "%OAUTH_STATUS%"=="ok" (
  call :log "OAuth already configured for %PROVIDER_NAME%."
  exit /b 0
)
if /I "%OAUTH_STATUS%"=="expiring" (
  call :log "OAuth for %PROVIDER_NAME% is valid but expiring soon."
  exit /b 0
)

call :log "OAuth missing for %PROVIDER_NAME%; starting login flow."
call "%OPENCLAW_BIN%" models auth login --provider "%PROVIDER_NAME%" --set-default
if errorlevel 1 (
  call :die "OAuth login failed for %PROVIDER_NAME%."
  exit /b 1
)

call :provider_oauth_status "%PROVIDER_NAME%" || (
  call :die "Failed to re-check OAuth status for %PROVIDER_NAME%."
  exit /b 1
)
if /I "%OAUTH_STATUS%"=="ok" exit /b 0
if /I "%OAUTH_STATUS%"=="expiring" exit /b 0
call :die "OAuth login completed but %PROVIDER_NAME% is still reported as %OAUTH_STATUS%."
exit /b 1

:ensure_requested_oauth_providers_ready
if /I "%OPENCLAW_OAUTH_SKIP%"=="1" (
  call :log "Skipping OAuth validation per OPENCLAW_OAUTH_SKIP."
  exit /b 0
)
if /I "%OPENCLAW_OAUTH_SKIP%"=="true" (
  call :log "Skipping OAuth validation per OPENCLAW_OAUTH_SKIP."
  exit /b 0
)
if /I "%OPENCLAW_OAUTH_SKIP%"=="yes" (
  call :log "Skipping OAuth validation per OPENCLAW_OAUTH_SKIP."
  exit /b 0
)
if /I "%OPENCLAW_OAUTH_SKIP%"=="on" (
  call :log "Skipping OAuth validation per OPENCLAW_OAUTH_SKIP."
  exit /b 0
)

set "RAW_OAUTH_PROVIDERS=%OPENCLAW_OAUTH_PROVIDERS%"
if not defined RAW_OAUTH_PROVIDERS exit /b 0

set "RAW_OAUTH_PROVIDERS=%RAW_OAUTH_PROVIDERS:,= %"
for %%P in (%RAW_OAUTH_PROVIDERS%) do (
  if not "%%~P"=="" (
    call :ensure_provider_oauth_ready "%%~P" || exit /b 1
  )
)
exit /b 0

:stop_residual_gateway_processes
setlocal EnableDelayedExpansion
for /f "usebackq tokens=1* delims=|" %%A in (`powershell -NoProfile -Command "$port = [int]$env:GATEWAY_PORT; Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $proc = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $_) -ErrorAction SilentlyContinue; if ($null -ne $proc) { '{0}|{1}' -f $_, $proc.CommandLine } }" 2^>nul`) do (
  set "PID=%%~A"
  set "PID_COMMAND=%%~B"
  echo !PID_COMMAND! | findstr /I /C:"openclaw-gateway" /C:"scripts/run-node.mjs gateway" /C:" openclaw.mjs gateway" /C:"startGatewayServer(" /C:"src/gateway/server.ts" >nul 2>&1
  if not errorlevel 1 (
    endlocal
    call :log "Stopping residual gateway process pid=%%~A"
    powershell -NoProfile -Command "Stop-Process -Id %%~A -Force -ErrorAction SilentlyContinue" >nul 2>&1
    setlocal EnableDelayedExpansion
  )
)
endlocal
exit /b 0

:health_check
set "HEALTH_TIMEOUT=%~1"
if not defined HEALTH_TIMEOUT set "HEALTH_TIMEOUT=5000"
set "HEALTH_RESULT="
for /f "delims=" %%R in ('powershell -NoProfile -Command "$port = [int]$env:GATEWAY_PORT; $timeout = [int]$env:HEALTH_TIMEOUT; $client = New-Object System.Net.Sockets.TcpClient; try { $iar = $client.BeginConnect('127.0.0.1', $port, $null, $null); if (-not $iar.AsyncWaitHandle.WaitOne($timeout, $false)) { exit 1 }; $client.EndConnect($iar) | Out-Null; 'ok' } catch { exit 1 } finally { $client.Dispose() }" 2^>nul') do set "HEALTH_RESULT=%%R"
if /I "%HEALTH_RESULT%"=="ok" (
  call :log "Health check OK."
  exit /b 0
)
call :log "Health check FAILED."
exit /b 1

:wait_for_health
set "WAIT_ATTEMPTS=%~1"
set "WAIT_SLEEP=%~2"
if not defined WAIT_ATTEMPTS set "WAIT_ATTEMPTS=15"
if not defined WAIT_SLEEP set "WAIT_SLEEP=2"

set /a WAIT_I=1
:wait_health_loop
if %WAIT_I% GTR %WAIT_ATTEMPTS% exit /b 1
call :health_check 4000
if not errorlevel 1 exit /b 0
timeout /t %WAIT_SLEEP% /nobreak >nul
set /a WAIT_I+=1
goto :wait_health_loop

:cmd_deploy
call :require_node_and_npm || exit /b 1
call :refresh_runtime_paths_
call :ensure_log_dir || exit /b 1
call :load_env_file || exit /b 1
call :ensure_openclaw_installed || exit /b 1
call :sync_env_to_state_dir || exit /b 1
call :ensure_mem0_deployed_if_needed || exit /b 1
call :ensure_requested_oauth_providers_ready || exit /b 1
call :configure_gateway_defaults || exit /b 1
call :install_gateway_daemon || exit /b 1
call :run_quiet "Stopping gateway service after deploy" "%OPENCLAW_BIN%" gateway stop || exit /b 1
call :log "Deploy finished. Service is installed but stopped."
call :log "Use: %~f0 start"
exit /b 0

:cmd_start
call :require_node_and_npm || exit /b 1
call :refresh_runtime_paths_
call :ensure_log_dir || exit /b 1
call :load_env_file || exit /b 1
call :ensure_openclaw_installed || exit /b 1
call :sync_env_to_state_dir || exit /b 1
call :ensure_mem0_deployed_if_needed || exit /b 1
call :ensure_requested_oauth_providers_ready || exit /b 1
call :stop_residual_gateway_processes || exit /b 1
call :run_quiet "Starting gateway service" "%OPENCLAW_BIN%" gateway start || exit /b 1
call :wait_for_health 15 2
if errorlevel 1 (
  call :die "Gateway started but health check did not pass in time."
  exit /b 1
)
call :log "Gateway started and healthy on port %GATEWAY_PORT%."
exit /b 0

:cmd_stop
call :require_node_and_npm || exit /b 1
call :refresh_runtime_paths_
call :ensure_log_dir || exit /b 1
call :load_env_file || exit /b 1
call :ensure_openclaw_installed || exit /b 1
call :run_quiet "Stopping gateway service" "%OPENCLAW_BIN%" gateway stop || exit /b 1
call :stop_residual_gateway_processes || exit /b 1
call :log "Gateway stopped."
exit /b 0

:cmd_status
call :require_node_and_npm || exit /b 1
call :refresh_runtime_paths_
call :ensure_log_dir || exit /b 1
call :load_env_file || exit /b 1
call :ensure_openclaw_installed || exit /b 1
call :disable_local_plugins || exit /b 1

call "%OPENCLAW_BIN%" gateway status
if errorlevel 1 call :log "gateway status returned non-zero."

call :health_check 4000
if errorlevel 1 (
  call :log "Gateway not healthy (or not running)."
  exit /b 1
)
exit /b 0

:cmd_health
call :require_node_and_npm || exit /b 1
call :refresh_runtime_paths_
call :ensure_log_dir || exit /b 1
call :load_env_file || exit /b 1
call :ensure_openclaw_installed || exit /b 1
call :disable_local_plugins || exit /b 1
call :health_check 8000
exit /b %ERRORLEVEL%

:cmd_logs
call :refresh_runtime_paths_
call :ensure_log_dir || exit /b 1

set "LOG_TARGET=gateway"
set "LOG_FOLLOW=0"
set "LOG_LINES=200"

:logs_parse
if "%~1"=="" goto logs_ready
if /I "%~1"=="gateway" (
  set "LOG_TARGET=gateway"
  shift
  goto logs_parse
)
if /I "%~1"=="stderr" (
  set "LOG_TARGET=stderr"
  shift
  goto logs_parse
)
if /I "%~1"=="bootstrap" (
  set "LOG_TARGET=bootstrap"
  shift
  goto logs_parse
)
if /I "%~1"=="-f" (
  set "LOG_FOLLOW=1"
  shift
  goto logs_parse
)
if /I "%~1"=="--follow" (
  set "LOG_FOLLOW=1"
  shift
  goto logs_parse
)
if /I "%~1"=="-n" (
  if "%~2"=="" (
    call :die "--lines requires a value"
    exit /b 1
  )
  set "LOG_LINES=%~2"
  shift
  shift
  goto logs_parse
)
if /I "%~1"=="--lines" (
  if "%~2"=="" (
    call :die "--lines requires a value"
    exit /b 1
  )
  set "LOG_LINES=%~2"
  shift
  shift
  goto logs_parse
)
call :die "Unknown logs option: %~1"
exit /b 1

:logs_ready
set "LOG_FILE="
if /I "%LOG_TARGET%"=="gateway" set "LOG_FILE=%GATEWAY_STDOUT_LOG%"
if /I "%LOG_TARGET%"=="stderr" set "LOG_FILE=%GATEWAY_STDERR_LOG%"
if /I "%LOG_TARGET%"=="bootstrap" set "LOG_FILE=%BOOTSTRAP_LOG_FILE%"

if not defined LOG_FILE (
  call :die "Unsupported logs target: %LOG_TARGET%"
  exit /b 1
)
if not exist "%LOG_FILE%" (
  call :die "Log file not found: %LOG_FILE%"
  exit /b 1
)

if "%LOG_FOLLOW%"=="1" (
  powershell -NoProfile -Command "Get-Content -Path '%LOG_FILE%' -Tail %LOG_LINES% -Wait"
) else (
  powershell -NoProfile -Command "Get-Content -Path '%LOG_FILE%' -Tail %LOG_LINES%"
)
exit /b %ERRORLEVEL%

:cmd_update
call :require_node_and_npm || exit /b 1
call :refresh_runtime_paths_
call :ensure_log_dir || exit /b 1
call :load_env_file || exit /b 1
call :update_openclaw || exit /b 1
call :sync_env_to_state_dir || exit /b 1
call :ensure_mem0_deployed_if_needed || exit /b 1
call :ensure_requested_oauth_providers_ready || exit /b 1
call :disable_local_plugins || exit /b 1
call :configure_gateway_defaults || exit /b 1
call :install_gateway_daemon || exit /b 1
call :run_quiet "Stopping gateway service after update" "%OPENCLAW_BIN%" gateway stop || exit /b 1
call :log "Update finished. Service remains stopped."
exit /b 0

:usage
echo Usage: %~f0 [deploy^|start^|stop^|status^|logs^|health^|update]
echo.
echo Commands:
echo   deploy   Install/update CLI + configure daemon + stop it (default, no startup)
echo   start    Start gateway service and wait for health check
echo   stop     Stop gateway service
echo   status   Show service status and health probe
echo   health   Run health check only
echo   logs     Tail logs (targets: gateway^|stderr^|bootstrap, flags: -f, -n)
echo   update   Optional: update CLI + reinstall daemon, then stop
echo.
echo Environment variables:
echo   OPENCLAW_ENV_FILE     Path to .env (default: %REPO_ROOT%\.env)
echo   OPENCLAW_NPM_SPEC     npm package spec (default: openclaw@%DEFAULT_OPENCLAW_VERSION%)
echo   OPENCLAW_NPM_PREFIX   npm prefix for local install (default: %NPM_PREFIX%)
echo   OPENCLAW_BIN          Explicit openclaw binary path
echo   OPENCLAW_GEMINI_BIN   Explicit gemini binary path
echo   OPENCLAW_OAUTH_PROVIDERS
echo                        Comma-separated OAuth providers to verify during deploy/start/update
echo                        (example: google-gemini-cli,openai-codex)
echo   OPENCLAW_OAUTH_SKIP   Skip OAuth verification when set to 1/true/yes/on
echo   OPENCLAW_GATEWAY_PORT Default gateway port (default: %DEFAULT_PORT%)
echo   OPENCLAW_MEM0_BOOTSTRAP_MODE
echo                        Mem0 deploy behavior during deploy/start/update: auto, always, or never
exit /b 0

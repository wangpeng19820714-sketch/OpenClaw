@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "SELF_PATH=%~f0"
set "TEMP_PS1=%TEMP%\setup-mem0-%RANDOM%%RANDOM%.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$self = [System.IO.Path]::GetFullPath($env:SELF_PATH); " ^
  "$temp = [System.IO.Path]::GetFullPath($env:TEMP_PS1); " ^
  "$marker = '###__EMBEDDED_POWERSHELL__###'; " ^
  "$lines = Get-Content -LiteralPath $self; " ^
  "$index = [Array]::IndexOf($lines, $marker); " ^
  "if ($index -lt 0) { throw 'Embedded PowerShell marker not found.' }; " ^
  "$body = $lines[($index + 1)..($lines.Length - 1)]; " ^
  "$encoding = New-Object System.Text.UTF8Encoding($false); " ^
  "[System.IO.File]::WriteAllLines($temp, $body, $encoding)"
if errorlevel 1 (
  echo Failed to prepare embedded PowerShell payload.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP_PS1%" %*
set "EXIT_CODE=%ERRORLEVEL%"
del "%TEMP_PS1%" >nul 2>&1
exit /b %EXIT_CODE%
###__EMBEDDED_POWERSHELL__###
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ($null -ne (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue)) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Get-EnvOrDefault {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Default
  )

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $Default
  }
  return $value
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter()][string[]]$ArgumentList = @(),
    [switch]$CaptureOutput,
    [switch]$IgnoreExitCode
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"

  try {
    if ($CaptureOutput) {
      $output = & $FilePath @ArgumentList 2>&1 | ForEach-Object { $_.ToString() }
      $exitCode = $LASTEXITCODE
      if (-not $IgnoreExitCode -and $exitCode -ne 0) {
        throw "Command failed ($exitCode): $FilePath $($ArgumentList -join ' ')`n$output"
      }
      return [string]::Join([Environment]::NewLine, @($output))
    }

    & $FilePath @ArgumentList
    $exitCode = $LASTEXITCODE
    if (-not $IgnoreExitCode -and $exitCode -ne 0) {
      throw "Command failed ($exitCode): $FilePath $($ArgumentList -join ' ')"
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Wait-Until {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Condition,
    [Parameter(Mandatory = $true)][int]$Attempts,
    [Parameter(Mandatory = $true)][int]$DelaySeconds,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  for ($i = 0; $i -lt $Attempts; $i++) {
    if (& $Condition) {
      return
    }
    Start-Sleep -Seconds $DelaySeconds
  }

  throw $FailureMessage
}

function Test-CommandExists {
  param([Parameter(Mandatory = $true)][string]$Name)

  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Assert-DockerReady {
  $composeVersion = Invoke-Checked -FilePath "docker" -ArgumentList @("compose", "version") -CaptureOutput -IgnoreExitCode
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose is not available. Install Docker Desktop with Compose V2 enabled."
  }

  $dockerInfo = Invoke-Checked -FilePath "docker" -ArgumentList @("info") -CaptureOutput -IgnoreExitCode
  if ($LASTEXITCODE -ne 0) {
    throw "Docker daemon is not reachable. Start Docker Desktop, switch to Linux containers, then retry.`n$dockerInfo"
  }
}

$homeDir = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
if ([string]::IsNullOrWhiteSpace($homeDir)) {
  throw "HOME/USERPROFILE is not set."
}

$repoUrl = Get-EnvOrDefault -Name "OPENCLAW_MEM0_REPO_URL" -Default "https://github.com/mem0ai/mem0.git"
$targetDir = Get-EnvOrDefault -Name "OPENCLAW_MEM0_UPSTREAM_DIR" -Default (Join-Path $homeDir ".openclaw/vendor/mem0-upstream")
$stateDir = Get-EnvOrDefault -Name "OPENCLAW_MEM0_STATE_DIR" -Default (Join-Path $homeDir ".openclaw/services/mem0")
$composeFile = Get-EnvOrDefault -Name "OPENCLAW_MEM0_COMPOSE_FILE" -Default "extensions-custom/docker-compose.mem0.yml"
$mem0BaseUrl = Get-EnvOrDefault -Name "OPENCLAW_MEM0_BASE_URL" -Default "http://127.0.0.1:8888"
$mem0ChatModel = Get-EnvOrDefault -Name "OPENCLAW_MEM0_CHAT_MODEL" -Default "qwen2.5:1.5b"
$mem0EmbedModel = Get-EnvOrDefault -Name "OPENCLAW_MEM0_EMBED_MODEL" -Default "nomic-embed-text"

if (-not (Test-CommandExists -Name "git")) {
  throw "git not found in PATH."
}
if (-not (Test-CommandExists -Name "docker")) {
  throw "docker not found in PATH."
}
Assert-DockerReady

Write-Host "Preparing Mem0 upstream outside the OpenClaw repo..."
Write-Host "Target: $targetDir"
Write-Host "State dir: $stateDir"

$targetParent = Split-Path -Parent $targetDir
if (-not [string]::IsNullOrWhiteSpace($targetParent)) {
  New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
}

$gitDir = Join-Path $targetDir ".git"
if (Test-Path -Path $gitDir -PathType Container) {
  Write-Host "Existing upstream checkout found. Pulling latest changes..."
  Invoke-Checked -FilePath "git" -ArgumentList @("-C", $targetDir, "pull", "--ff-only")
} elseif (Test-Path -Path $targetDir) {
  throw "Directory $targetDir exists but is not a git checkout. Delete it or set OPENCLAW_MEM0_UPSTREAM_DIR to another path."
} else {
  Write-Host "Cloning Mem0 from $repoUrl..."
  Invoke-Checked -FilePath "git" -ArgumentList @("clone", $repoUrl, $targetDir)
}

@(
  (Join-Path $stateDir "history"),
  (Join-Path $stateDir "postgres"),
  (Join-Path $stateDir "neo4j"),
  (Join-Path $stateDir "ollama")
) | ForEach-Object {
  New-Item -ItemType Directory -Force -Path $_ | Out-Null
}

$env:OPENCLAW_MEM0_UPSTREAM_DIR = $targetDir
$env:OPENCLAW_MEM0_STATE_DIR = $stateDir

$composeArgs = @("compose", "-f", $composeFile)

Write-Host "Starting Mem0 Docker stack..."
Invoke-Checked -FilePath "docker" -ArgumentList ($composeArgs + @("up", "-d", "--build"))

Write-Host "Waiting for Ollama service..."
Wait-Until -Attempts 60 -DelaySeconds 2 -FailureMessage "Timed out waiting for Ollama service." -Condition {
  Invoke-Checked -FilePath "docker" -ArgumentList ($composeArgs + @("exec", "-T", "ollama", "ollama", "list")) -IgnoreExitCode | Out-Null
  return $LASTEXITCODE -eq 0
}

Write-Host "Pulling Ollama chat model: $mem0ChatModel"
Invoke-Checked -FilePath "docker" -ArgumentList ($composeArgs + @("exec", "-T", "ollama", "ollama", "pull", $mem0ChatModel))

Write-Host "Pulling Ollama embedding model: $mem0EmbedModel"
Invoke-Checked -FilePath "docker" -ArgumentList ($composeArgs + @("exec", "-T", "ollama", "ollama", "pull", $mem0EmbedModel))

Write-Host "Waiting for Mem0 API..."
Wait-Until -Attempts 60 -DelaySeconds 2 -FailureMessage "Timed out waiting for Mem0 API at $mem0BaseUrl." -Condition {
  try {
    Invoke-WebRequest -Uri "$mem0BaseUrl/docs" -UseBasicParsing -TimeoutSec 5 | Out-Null
    return $true
  } catch {
    return $false
  }
}

Write-Host "Configuring Mem0 to use local Ollama + local Docker storage..."
$configurePayload = @{
  version = "v1.1"
  vector_store = @{
    provider = "pgvector"
    config = @{
      host = "postgres"
      port = 5432
      dbname = "postgres"
      user = "postgres"
      password = "postgres"
      collection_name = "openclaw_memories_upstream"
    }
  }
  graph_store = @{
    provider = "neo4j"
    config = @{
      url = "bolt://neo4j:7687"
      username = "neo4j"
      password = "mem0graph"
    }
  }
  llm = @{
    provider = "ollama"
    config = @{
      model = $mem0ChatModel
      temperature = 0.2
      ollama_base_url = "http://ollama:11434"
    }
  }
  embedder = @{
    provider = "ollama"
    config = @{
      model = $mem0EmbedModel
      ollama_base_url = "http://ollama:11434"
    }
  }
  history_db_path = "/app/history/history.db"
  custom_fact_extraction_prompt = 'Extract durable facts from the input. Return strict JSON only in the exact shape {"facts":["fact 1","fact 2"]}. Every item in facts must be a plain string. Never return nested arrays. Never return objects inside facts. If there are no durable facts, return {"facts":[]}.'
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Uri "$mem0BaseUrl/configure" -Method Post -ContentType "application/json" -Body $configurePayload | Out-Null

Write-Host "Reconciling pgvector dimensions with the local embedding model..."
$embedProbePython = 'import json, os, urllib.request as u; data=json.dumps({"model": os.environ["MODEL_NAME"], "input": "dimension probe"}).encode(); req=u.Request("http://ollama:11434/api/embed", data=data, headers={"Content-Type": "application/json"}); resp=json.load(u.urlopen(req)); emb=resp.get("embeddings") or []; print(len(emb[0]) if emb else 0)'
$embedProbePythonBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($embedProbePython))
$embedProbeLauncher = 'import base64, os; exec(base64.b64decode(os.environ[''PYCODE_B64'']).decode(''utf-8''))'
$embedDim = (Invoke-Checked -FilePath "docker" -CaptureOutput -ArgumentList ($composeArgs + @("exec", "-T", "-e", "MODEL_NAME=$mem0EmbedModel", "-e", "PYCODE_B64=$embedProbePythonBase64", "mem0", "python", "-c", $embedProbeLauncher))).Trim()

$currentVectorDimQuery = @'
SELECT COALESCE(
  (regexp_match(format_type(a.atttypid, a.atttypmod), 'vector\(([0-9]+)\)'))[1]::int,
  0
)
FROM pg_attribute a
WHERE a.attrelid = 'openclaw_memories_upstream'::regclass
  AND a.attname = 'vector'
  AND NOT a.attisdropped;
'@
$currentVectorDim = (Invoke-Checked -FilePath "docker" -CaptureOutput -ArgumentList ($composeArgs + @("exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c", $currentVectorDimQuery))).Trim()

if ($embedDim -eq "0") {
  throw "Failed to detect embedding dimension from Ollama."
}

if ($currentVectorDim -ne $embedDim) {
  $rowCountQuery = "SELECT count(*) FROM openclaw_memories_upstream;"
  $rowCount = (Invoke-Checked -FilePath "docker" -CaptureOutput -ArgumentList ($composeArgs + @("exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c", $rowCountQuery))).Trim()

  if ($rowCount -ne "0") {
    throw "Vector dimension mismatch detected: table=openclaw_memories_upstream current=$currentVectorDim embedder=$embedDim. The table is not empty, so setup-mem0.bat will not rewrite the schema automatically."
  }

  Write-Host "Updating openclaw_memories_upstream.vector from $currentVectorDim to $embedDim dimensions..."
  $updateSchemaQuery = @"
DROP INDEX IF EXISTS openclaw_memories_upstream_hnsw_idx;
ALTER TABLE openclaw_memories_upstream
  ALTER COLUMN vector TYPE vector($embedDim);
CREATE INDEX openclaw_memories_upstream_hnsw_idx
  ON openclaw_memories_upstream
  USING hnsw (vector vector_cosine_ops);
"@
  Invoke-Checked -FilePath "docker" -ArgumentList ($composeArgs + @("exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "postgres", "-c", $updateSchemaQuery))
}

Write-Host "Mem0 upstream is ready at $targetDir"
Write-Host "Mem0 API is running at $mem0BaseUrl"
Write-Host "This repository now only keeps the OpenClaw bridge plugin in extensions-custom/mem0-openclaw."

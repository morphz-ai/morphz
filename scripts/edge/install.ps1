param(
  [string]$Code = $env:MORPHZ_BOOTSTRAP_CODE,
  [string]$ServerUrl = $env:MORPHZ_EDGE_SERVER_URL,
  [string]$Workspace = $(Get-Location).Path,
  [string]$NodeName = $env:COMPUTERNAME,
  [int]$Workers = 0,
  [switch]$FullAccess,
  [string]$ManifestUrl = $(if ($env:MORPHZ_EDGE_MANIFEST_URL) { $env:MORPHZ_EDGE_MANIFEST_URL } else { "https://morphz.ai/edge/releases/manifest.json" })
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -lt 7) {
  throw "Morphz Edge installation requires PowerShell 7 or newer so the release signature can be verified."
}
if (-not $Code) { throw "A short-lived bootstrap Code is required." }
if (-not $ServerUrl) { throw "The Edge Server URL is required." }
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) { throw "Workspace is not a directory: $Workspace" }
if (-not $ManifestUrl.StartsWith("https://") -and $env:MORPHZ_EDGE_ALLOW_INSECURE_TEST_URLS -ne "1") {
  throw "Manifest URL must use HTTPS."
}
if (-not $ServerUrl.StartsWith("https://") -and $env:MORPHZ_EDGE_ALLOW_INSECURE_TEST_URLS -ne "1") {
  throw "Edge Server URL must use HTTPS."
}

$architecture = switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { "x86_64" }
  "ARM64" { "aarch64" }
  default { throw "Unsupported Windows architecture: $env:PROCESSOR_ARCHITECTURE" }
}
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("morphz-edge-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  $manifestPath = Join-Path $temporary "manifest.json"
  $signaturePath = Join-Path $temporary "manifest.json.sig"
  Invoke-WebRequest -UseBasicParsing -Uri $ManifestUrl -OutFile $manifestPath
  Invoke-WebRequest -UseBasicParsing -Uri ($ManifestUrl + ".sig") -OutFile $signaturePath

  $publicKeyBase64 = if ($env:MORPHZ_EDGE_RELEASE_PUBLIC_KEY_PEM_B64) { $env:MORPHZ_EDGE_RELEASE_PUBLIC_KEY_PEM_B64 } else { "__MORPHZ_EDGE_RELEASE_PUBLIC_KEY_PEM_B64__" }
  if ($publicKeyBase64.StartsWith("__MORPHZ_")) { throw "Installer has not been rendered with the production release public key." }
  $publicKeyPem = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($publicKeyBase64))
  $ecdsa = [Security.Cryptography.ECDsa]::Create()
  try {
    $ecdsa.ImportFromPem($publicKeyPem)
    $verified = $ecdsa.VerifyData(
      [IO.File]::ReadAllBytes($manifestPath),
      [IO.File]::ReadAllBytes($signaturePath),
      [Security.Cryptography.HashAlgorithmName]::SHA256,
      [Security.Cryptography.DSASignatureFormat]::Rfc3279DerSequence
    )
    if (-not $verified) { throw "Release manifest signature verification failed." }
  } finally {
    $ecdsa.Dispose()
  }

  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if ($manifest.schema_version -ne 1) { throw "Unsupported release manifest schema." }
  $matches = @($manifest.artifacts | Where-Object { $_.platform -eq "windows" -and $_.architecture -eq $architecture })
  if ($matches.Count -ne 1) { throw "Release manifest does not contain exactly one Windows/$architecture artifact." }
  $artifactInfo = $matches[0]
  if (-not $artifactInfo.url.StartsWith("https://") -and $env:MORPHZ_EDGE_ALLOW_INSECURE_TEST_URLS -ne "1") {
    throw "Artifact URL must use HTTPS."
  }
  if ([string]$artifactInfo.archive_format -ne "zip") {
    throw "Windows Morphz Edge releases must be signed ZIP bundles."
  }
  if ([string]$artifactInfo.entrypoint -ne "morphz-edge.exe") {
    throw "The Windows release entrypoint is invalid."
  }
  $download = Join-Path $temporary "morphz-edge.zip"
  Invoke-WebRequest -UseBasicParsing -Uri $artifactInfo.url -OutFile $download
  if ((Get-Item -LiteralPath $download).Length -ne [long]$artifactInfo.size_bytes) { throw "Downloaded artifact size does not match the manifest." }
  $digest = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($digest -ne ([string]$artifactInfo.sha256).ToLowerInvariant()) { throw "Downloaded artifact SHA-256 does not match the manifest." }
  Unblock-File -LiteralPath $download

  $bundle = Join-Path $temporary "bundle"
  Expand-Archive -LiteralPath $download -DestinationPath $bundle
  $sourceBinary = Join-Path $bundle "morphz-edge.exe"
  if (-not (Test-Path -LiteralPath $sourceBinary -PathType Leaf)) {
    throw "The signed Windows bundle does not contain morphz-edge.exe."
  }

  $installDir = if ($env:MORPHZ_EDGE_INSTALL_DIR) { $env:MORPHZ_EDGE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Morphz\bin" }
  $stateDir = if ($env:MORPHZ_EDGE_STATE_DIR) { $env:MORPHZ_EDGE_STATE_DIR } else { Join-Path $HOME ".morphz\edge" }
  New-Item -ItemType Directory -Force -Path $installDir, $stateDir | Out-Null
  $binary = Join-Path $installDir "morphz-edge.exe"
  $receipt = Join-Path $stateDir "bootstrap-receipt.json"
  $backup = Join-Path $temporary "previous-bin"
  if (Test-Path -LiteralPath $installDir) {
    New-Item -ItemType Directory -Path $backup | Out-Null
    Get-ChildItem -LiteralPath $installDir -Force | Copy-Item -Destination $backup -Recurse -Force
  }
  Get-ChildItem -LiteralPath $bundle -Force | Copy-Item -Destination $installDir -Recurse -Force

  $arguments = @("--workspace", $Workspace, "bootstrap", "--server-url", $ServerUrl, "--pairing-code", $Code, "--receipt-file", $receipt, "--json")
  if ($NodeName) { $arguments += @("--node-name", $NodeName) }
  if ($Workers -gt 0) { $arguments += @("--workers", [string]$Workers) }
  if ($FullAccess) { $arguments += "--full-access" }
  try {
    & $binary @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "morphz-edge exited with code $LASTEXITCODE" }
  } catch {
    foreach ($file in Get-ChildItem -LiteralPath $bundle -File -Recurse) {
      $relative = [IO.Path]::GetRelativePath($bundle, $file.FullName)
      $installedFile = Join-Path $installDir $relative
      Remove-Item -LiteralPath $installedFile -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $backup) {
      Get-ChildItem -LiteralPath $backup -Force | Copy-Item -Destination $installDir -Recurse -Force
    }
    throw "Pairing failed; the previous Edge bundle was restored and no background task was registered. $($_.Exception.Message)"
  }

  if ($env:MORPHZ_EDGE_INSTALL_NO_SERVICE -ne "1") {
    $taskName = "Morphz Edge"
    $action = New-ScheduledTaskAction -Execute $binary -Argument ("service-run --receipt-file `"" + $receipt + "`"")
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description "Morphz Edge Node" -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
  }
  & $binary status | Out-Null
  Write-Host "morphz-edge $($manifest.version) installed and paired."
  Write-Host "Workspace: $Workspace"
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}

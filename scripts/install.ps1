$ErrorActionPreference = "Stop"

$repository = if ($env:MORPHZ_GITHUB_REPOSITORY) { $env:MORPHZ_GITHUB_REPOSITORY } else { "morphz-ai/morphz" }
$version = if ($env:MORPHZ_VERSION) { $env:MORPHZ_VERSION } else { "latest" }
$installDir = if ($env:MORPHZ_INSTALL_DIR) { $env:MORPHZ_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Morphz\bin" }

Write-Host "[1/5] Detecting system"
if (-not [Environment]::Is64BitOperatingSystem) {
  throw "Morphz requires 64-bit Windows."
}
if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64" -and $env:PROCESSOR_ARCHITEW6432 -ne "AMD64") {
  throw "No Morphz release is published for this Windows architecture."
}

$asset = "morphz-windows-x86_64.zip"
if ($env:MORPHZ_RELEASE_BASE_URL) {
  $releaseBase = $env:MORPHZ_RELEASE_BASE_URL.TrimEnd("/")
} elseif ($version -eq "latest") {
  $releaseBase = "https://github.com/$repository/releases/latest/download"
} else {
  $releaseBase = "https://github.com/$repository/releases/download/$version"
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("morphz-install-" + [Guid]::NewGuid().ToString("N"))
$archive = Join-Path $temporary $asset
$checksumFile = "$archive.sha256"
$unpacked = Join-Path $temporary "unpacked"

try {
  New-Item -ItemType Directory -Force $temporary | Out-Null
  Write-Host "[2/5] Downloading $asset"
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$asset" -OutFile $archive
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$asset.sha256" -OutFile $checksumFile

  Write-Host "[3/5] Verifying SHA-256 checksum"
  $expected = ((Get-Content -Raw $checksumFile).Trim() -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
  if (-not $expected -or $expected -ne $actual) {
    throw "Downloaded release checksum does not match."
  }

  Write-Host "[4/5] Installing to $installDir"
  Expand-Archive -LiteralPath $archive -DestinationPath $unpacked -Force
  $binary = Join-Path $unpacked "morphz.exe"
  if (-not (Test-Path -LiteralPath $binary)) {
    throw "Release archive does not contain morphz.exe."
  }

  New-Item -ItemType Directory -Force $installDir | Out-Null
  @(
    "morphz.exe",
    "morphz-windows-sandbox-runner.exe",
    "morphz-windows-command-runner.exe",
    "morphz-windows-sandbox-setup.exe"
  ) | ForEach-Object {
    $component = Join-Path $unpacked $_
    if (-not (Test-Path -LiteralPath $component)) {
      throw "Release archive does not contain required component $_."
    }
    Copy-Item -LiteralPath $component -Destination $installDir -Force
  }

  Write-Host "[5/5] Configuring the command path"
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $pathEntries = @($userPath -split ";" | Where-Object { $_ })
  if ($pathEntries -notcontains $installDir) {
    $updatedPath = (@($pathEntries) + $installDir) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $updatedPath, "User")
  }
  if (($env:Path -split ";") -notcontains $installDir) {
    $env:Path = "$installDir;$env:Path"
  }

  Write-Host ""
  Write-Host "Morphz is installed."
  Write-Host "Run now: & `"$installDir\morphz.exe`" setup"
  Write-Host "New terminals can run: morphz setup"
} finally {
  if (Test-Path -LiteralPath $temporary) {
    Remove-Item -LiteralPath $temporary -Recurse -Force
  }
}

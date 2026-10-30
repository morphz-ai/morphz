# Exercise the production Windows installer with native version-reporting
# binaries, real ZIP archives/checksums, and a deterministic download transport.
$ErrorActionPreference = "Stop"
if (-not $IsWindows) { throw "This acceptance suite requires Windows." }
$installer = Join-Path $PSScriptRoot "install.ps1"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("morphz-installer-test-" + [Guid]::NewGuid().ToString("N"))
$savedEnvironment = @{}
foreach ($key in @("MORPHZ_VERSION", "MORPHZ_RELEASE_BASE_URL", "MORPHZ_INSTALL_DIR", "MORPHZ_NO_MODIFY_PATH", "Path")) {
  $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
}
$downloadState = [pscustomobject]@{
  Requests = [Collections.Generic.List[string]]::new()
  ActiveFixture = ""
}

# The production installer runs in its own script scope. Capture this shared
# object explicitly rather than resolving script: variables in its caller.
$downloadTransport = {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  if (-not $Uri.StartsWith("https://fixtures.invalid/release/")) { throw "Unexpected download URL: $Uri" }
  $downloadState.Requests.Add($Uri)
  $fixtureFile = Join-Path $downloadState.ActiveFixture ([Uri]$Uri).Segments[-1]
  Copy-Item -LiteralPath $fixtureFile -Destination $OutFile
}.GetNewClosure()
Set-Item -Path Function:Invoke-WebRequest -Value $downloadTransport

function Invoke-InstallerFixture {
  param([string]$Fixture, [string]$Requested, [string]$Destination, [string]$ExpectedError = "")
  $downloadState.ActiveFixture = $Fixture
  $downloadState.Requests.Clear()
  $env:MORPHZ_VERSION = $Requested
  $env:MORPHZ_RELEASE_BASE_URL = "https://fixtures.invalid/release"
  $env:MORPHZ_INSTALL_DIR = $Destination
  $env:MORPHZ_NO_MODIFY_PATH = "1"
  $caught = $null
  try { & $installer | Out-Null } catch { $caught = $_ }
  if ($ExpectedError) {
    if (-not $caught -or $caught.ToString() -notlike "*$ExpectedError*") {
      throw "Expected '$ExpectedError', received '$caught'."
    }
  } elseif ($caught) { throw $caught }
}

try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  # Reproduce the real CI failure boundary: a separate script invokes the
  # transport while its script-scoped state is absent. The closure must retain
  # the test's shared object, without using process-global variables.
  $scopeFixture = Join-Path $testRoot "scope-fixture"
  New-Item -ItemType Directory -Path $scopeFixture | Out-Null
  [IO.File]::WriteAllText((Join-Path $scopeFixture "scope.bin"), "scope fixture")
  $scopeProbe = Join-Path $testRoot "scope-probe.ps1"
  [IO.File]::WriteAllText($scopeProbe, @'
param([string]$Destination)
$script:downloadState = $null
Invoke-WebRequest -UseBasicParsing -Uri "https://fixtures.invalid/release/scope.bin" -OutFile $Destination
'@)
  $downloadState.ActiveFixture = $scopeFixture
  $scopeOutput = Join-Path $testRoot "scope-output.bin"
  & $scopeProbe -Destination $scopeOutput
  if ($downloadState.Requests.Count -ne 1 -or [IO.File]::ReadAllText($scopeOutput) -ne "scope fixture") {
    throw "Download transport lost its captured state across a child script scope."
  }

  foreach ($fixture in @(@{Name="stable";Version="0.1.4"}, @{Name="rc";Version="0.1.4-rc.1"})) {
    $fixtureDir = Join-Path $testRoot $fixture.Name
    $bundle = Join-Path $fixtureDir "bundle"
    New-Item -ItemType Directory -Path $bundle -Force | Out-Null
    $source = Join-Path $fixtureDir "fixture.rs"
    [IO.File]::WriteAllText($source, ('fn main() { println!("morphz ' + $fixture.Version + ' (git fixture-source)"); }'))
    & rustc --edition=2021 $source -o (Join-Path $bundle "morphz.exe")
    if ($LASTEXITCODE -ne 0) { throw "Native installer fixture did not compile." }
    foreach ($helper in @("morphz-windows-sandbox-runner.exe", "morphz-windows-command-runner.exe", "morphz-windows-sandbox-setup.exe")) {
      Copy-Item (Join-Path $bundle "morphz.exe") (Join-Path $bundle $helper)
    }
    $archive = Join-Path $fixtureDir "morphz-windows-x86_64.zip"
    Compress-Archive -Path (Join-Path $bundle "*") -DestinationPath $archive
    [IO.File]::WriteAllText("$archive.sha256", ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant() + "  morphz-windows-x86_64.zip`n"))
  }
  $stable = Join-Path $testRoot "stable"
  $rc = Join-Path $testRoot "rc"
  $destination = Join-Path $testRoot "installed"
  Invoke-InstallerFixture $stable "latest" $destination
  $original = (Get-FileHash (Join-Path $destination "morphz.exe")).Hash
  Invoke-InstallerFixture $rc "latest" $destination "Stable installation rejected prerelease"
  if ((Get-FileHash (Join-Path $destination "morphz.exe")).Hash -ne $original) { throw "Rejected RC changed the installation." }
  Invoke-InstallerFixture $rc "v0.1.4-rc.2" $destination "does not match requested version"
  if ((Get-FileHash (Join-Path $destination "morphz.exe")).Hash -ne $original) { throw "Version mismatch changed the installation." }
  Invoke-InstallerFixture (Join-Path $testRoot "missing") "v0.1.4-rc.1" $destination "Cannot find path"
  if ($downloadState.Requests.Count -ne 1) { throw "Unavailable release triggered an unexpected fallback download." }
  if ((Get-FileHash (Join-Path $destination "morphz.exe")).Hash -ne $original) { throw "Missing release changed the installation." }
  Invoke-InstallerFixture $rc "v0.1.4-rc.1" $destination
  $actual = & (Join-Path $destination "morphz.exe") --version
  if ($actual -ne "morphz 0.1.4-rc.1 (git fixture-source)") { throw "Explicit RC installation did not install the requested binary." }
  [IO.File]::WriteAllText((Join-Path $rc "morphz-windows-x86_64.zip.sha256"), ("0" * 64))
  $rcHash = (Get-FileHash (Join-Path $destination "morphz.exe")).Hash
  Invoke-InstallerFixture $rc "v0.1.4-rc.1" $destination "checksum does not match"
  if ((Get-FileHash (Join-Path $destination "morphz.exe")).Hash -ne $rcHash) { throw "Bad checksum changed the installation." }
  Write-Host "Windows installer acceptance passed (stable, explicit RC, mismatch, no fallback, checksum)."
} finally {
  foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], "Process") }
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}

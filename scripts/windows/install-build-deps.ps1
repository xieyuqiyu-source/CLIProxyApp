[CmdletBinding()]
param(
  [switch]$SkipVSBuildTools,
  [switch]$SkipRust,
  [switch]$SkipGo,
  [switch]$SkipGit
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-Admin {
  if (-not (Test-Admin)) {
    throw "Run this script in an Administrator PowerShell window."
  }
}

function Ensure-Directory {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

function Download-File {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  Write-Host "Downloading: $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
  return $Destination
}

function Find-CommandPath {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  return $null
}

function Install-VSBuildTools {
  if ($SkipVSBuildTools) {
    Write-Host "Skip VS Build Tools"
    return
  }

  if (Find-CommandPath "cl.exe") {
    Write-Host "cl.exe already exists. Skip VS Build Tools."
    return
  }

  Write-Step "Install Visual Studio 2022 Build Tools"
  $installer = Join-Path $script:TempDir "vs_BuildTools.exe"
  Download-File -Url "https://aka.ms/vs/17/release/vs_BuildTools.exe" -Destination $installer | Out-Null

  $args = @(
    '--quiet',
    '--wait',
    '--norestart',
    '--nocache',
    '--installPath', 'C:\BuildTools',
    '--add', 'Microsoft.VisualStudio.Workload.VCTools',
    '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.22621',
    '--add', 'Microsoft.VisualStudio.Component.VC.CMake.Project'
  )

  $process = Start-Process -FilePath $installer -ArgumentList $args -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "VS Build Tools install failed. Exit code: $($process.ExitCode)"
  }
}

function Install-Rust {
  if ($SkipRust) {
    Write-Host "Skip Rust"
    return
  }

  if (Find-CommandPath "cargo.exe") {
    Write-Host "cargo.exe already exists. Skip Rust."
    return
  }

  Write-Step "Install Rust"
  $installer = Join-Path $script:TempDir "rustup-init.exe"
  Download-File -Url "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" -Destination $installer | Out-Null

  $process = Start-Process -FilePath $installer -ArgumentList '-y', '--profile', 'default', '--default-toolchain', 'stable-x86_64-pc-windows-msvc' -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Rust install failed. Exit code: $($process.ExitCode)"
  }
}

function Get-GoInstallerUrl {
  $releases = Invoke-RestMethod -Uri 'https://go.dev/dl/?mode=json'
  $latest = $releases | Select-Object -First 1
  $windowsMsi = $latest.files | Where-Object { $_.filename -like '*windows-amd64.msi' } | Select-Object -First 1
  if (-not $windowsMsi) {
    throw "Cannot find a Go Windows AMD64 installer."
  }
  return "https://go.dev/dl/$($windowsMsi.filename)"
}

function Install-Go {
  if ($SkipGo) {
    Write-Host "Skip Go"
    return
  }

  if (Find-CommandPath "go.exe") {
    Write-Host "go.exe already exists. Skip Go."
    return
  }

  Write-Step "Install Go"
  $url = Get-GoInstallerUrl
  $fileName = Split-Path $url -Leaf
  $installer = Join-Path $script:TempDir $fileName
  Download-File -Url $url -Destination $installer | Out-Null

  $process = Start-Process -FilePath "msiexec.exe" -ArgumentList '/i', "`"$installer`"", '/qn', '/norestart' -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Go install failed. Exit code: $($process.ExitCode)"
  }
}

function Get-GitInstallerUrl {
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest'
  $asset = $release.assets | Where-Object { $_.name -match '64-bit\.exe$' } | Select-Object -First 1
  if (-not $asset) {
    throw "Cannot find a Git for Windows 64-bit installer."
  }
  return $asset.browser_download_url
}

function Install-Git {
  if ($SkipGit) {
    Write-Host "Skip Git"
    return
  }

  if (Find-CommandPath "git.exe") {
    Write-Host "git.exe already exists. Skip Git."
    return
  }

  Write-Step "Install Git for Windows"
  $url = Get-GitInstallerUrl
  $fileName = Split-Path $url -Leaf
  $installer = Join-Path $script:TempDir $fileName
  Download-File -Url $url -Destination $installer | Out-Null

  $process = Start-Process -FilePath $installer -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-' -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Git install failed. Exit code: $($process.ExitCode)"
  }
}

function Add-PathIfExists {
  param([string]$PathToAdd)
  if ((Test-Path -LiteralPath $PathToAdd) -and -not ($env:Path -split ';' | Where-Object { $_ -eq $PathToAdd })) {
    $env:Path = "${PathToAdd};$env:Path"
  }
}

function Refresh-SessionPath {
  Add-PathIfExists "C:\Program Files\Git\cmd"
  Add-PathIfExists "C:\Program Files\Go\bin"
  Add-PathIfExists (Join-Path $env:USERPROFILE ".cargo\bin")
}

function Print-Versions {
  Write-Step "Install result"
  foreach ($cmd in @("git", "node", "cargo", "go", "cl")) {
    $path = Find-CommandPath $cmd
    if ($path) {
      Write-Host ("{0,-8} {1}" -f $cmd, $path) -ForegroundColor Green
    }
    else {
      Write-Host ("{0,-8} not found" -f $cmd) -ForegroundColor Yellow
    }
  }

  Write-Host ""
  try { & git --version } catch {}
  try { & node -v } catch {}
  try { & npm -v } catch {}
  try { & rustc -V } catch {}
  try { & cargo -V } catch {}
  try { & go version } catch {}
}

Ensure-Admin

$script:TempDir = Join-Path $env:USERPROFILE "Downloads\codex-setup"
Ensure-Directory $script:TempDir

Write-Step "Start installing Windows build dependencies"
Install-VSBuildTools
Install-Rust
Install-Go
Install-Git
Refresh-SessionPath
Print-Versions

Write-Host ""
Write-Host "Done. Close this PowerShell window and open a new one before building." -ForegroundColor Cyan

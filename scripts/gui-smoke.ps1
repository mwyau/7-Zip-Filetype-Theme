# Fail if a patched 7zFM.exe cannot start and create a top-level UI Automation window.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -Raw (Join-Path $root 'config/themes.json') | ConvertFrom-Json
$themes = @($manifest.filetypes | ForEach-Object { $_.slug }) + @($manifest.ribbon.slug)
$temp = Join-Path ([IO.Path]::GetTempPath()) ('7zip-gui-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

try {
  foreach ($arch in @('x86', 'x64')) {
    $upstream = Join-Path $root ".build/upstream/$arch"
    if (-not (Test-Path (Join-Path $upstream '7zFM.exe'))) {
      throw "Missing official 7zFM.exe for $arch"
    }
    foreach ($theme in $themes) {
      # Keep 7zFM.exe together with its original runtime dependencies.
      $stage = Join-Path $temp "$arch-$theme"
      Copy-Item -LiteralPath $upstream -Destination $stage -Recurse -Force
      $target = if ($theme -eq $manifest.ribbon.slug) { '7zFM.exe' } else { '7z.dll' }
      $patched = Join-Path $root ".build/packages/$arch/$theme/$target"
      if (-not (Test-Path $patched)) { throw "Missing patched $target for $arch/$theme" }
      Copy-Item -LiteralPath $patched -Destination (Join-Path $stage $target) -Force

      $exe = Join-Path $stage '7zFM.exe'
      $process = $null
      try {
        $process = Start-Process -FilePath $exe -WorkingDirectory $stage -PassThru -ErrorAction Stop
        Start-Sleep -Seconds 3
        $process.Refresh()
        if ($process.HasExited) {
          throw "$arch/$($theme): 7zFM.exe exited during startup (exit code $($process.ExitCode))."
        }
        # MainWindowHandle identifies a top-level window; verify that Windows UI Automation
        # recognizes it as a Window owned by this patched File Manager process.
        $foundWindow = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
          $process.Refresh()
          if ($process.HasExited) {
            throw "$arch/$($theme): 7zFM.exe exited before creating a File Manager window."
          }
          $handle = $process.MainWindowHandle
          if ($handle -ne [IntPtr]::Zero) {
            try {
              $element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
              if ($null -ne $element -and
                  $element.Current.ProcessId -eq $process.Id -and
                  $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) {
                $foundWindow = $true
                break
              }
            } catch [System.Windows.Automation.ElementNotAvailableException] {
              # Window was recreated while probing; retry until the deadline.
            } catch [System.Runtime.InteropServices.COMException] {
              # Transient UI Automation availability error during startup.
            }
          }
          Start-Sleep -Milliseconds 250
        }
        if (-not $foundWindow) {
          throw "$arch/$($theme): 7zFM.exe stayed running but did not create a top-level File Manager window."
        }
        Write-Host "$arch/$($theme): patched File Manager started and exposed a UI Automation window."
      } finally {
        if ($null -ne $process) {
          try {
            $process.Refresh()
            if (-not $process.HasExited) {
              Stop-Process -Id $process.Id -Force -ErrorAction Stop
              [void]$process.WaitForExit(5000)
            }
          } catch {
            Write-Warning "Unable to cleanly terminate smoke-test process $($process.Id): $_"
          }
          $process.Dispose()
        }
      }
    }
  }
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

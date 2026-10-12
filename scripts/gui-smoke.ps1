param(
  [string]$LegacyRibbonRoot,
  [switch]$BaselineOnly
)

# Fail if File Manager cannot start or Tools > Options cannot open with the patched Ribbon.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class RibbonGuiWindow
{
    public IntPtr Handle { get; set; }
    public uint ProcessId { get; set; }
    public string Title { get; set; }
    public string ClassName { get; set; }
    public bool IsVisible { get; set; }
}

public static class RibbonGuiNative
{
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr state);

    [DllImport("user32.dll", EntryPoint = "EnumWindows", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);

    [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId", ExactSpelling = true, SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", EntryPoint = "GetWindowTextW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern int GetWindowTextW(IntPtr window, StringBuilder text, int maximum);

    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern int GetClassNameW(IntPtr window, StringBuilder className, int maximum);

    [DllImport("user32.dll", EntryPoint = "IsWindowVisible", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", EntryPoint = "PostMessageW", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    public static RibbonGuiWindow[] GetProcessWindows(int processId)
    {
        List<RibbonGuiWindow> windows = new List<RibbonGuiWindow>();
        EnumWindowsCallback callback = delegate(IntPtr window, IntPtr state)
        {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner == (uint)processId)
            {
                StringBuilder title = new StringBuilder(512);
                StringBuilder className = new StringBuilder(256);
                GetWindowTextW(window, title, title.Capacity);
                GetClassNameW(window, className, className.Capacity);
                windows.Add(new RibbonGuiWindow { Handle = window, ProcessId = owner, Title = title.ToString(), ClassName = className.ToString(), IsVisible = IsWindowVisible(window) });
            }
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        return windows.ToArray();
    }

    public static bool PostOptionsCommand(IntPtr window, int commandId)
    {
        return PostMessageW(window, 0x0111, new IntPtr(commandId), IntPtr.Zero);
    }

    public static bool CloseDialog(IntPtr window)
    {
        return PostMessageW(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
    }
}
'@
Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -Raw (Join-Path $root 'config/themes.json') | ConvertFrom-Json
$themes = @($manifest.filetypes | ForEach-Object { $_.slug }) + @($manifest.ribbon.slug)
$temp = Join-Path ([IO.Path]::GetTempPath()) ('7zip-gui-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null

function Get-VerifiedWindowElement([RibbonGuiWindow]$window, [int]$processId) {
  try {
    $element = [System.Windows.Automation.AutomationElement]::FromHandle($window.Handle)
    if ($null -ne $element -and
        $element.Current.ProcessId -eq $processId -and
        $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) {
      return $element
    }
  } catch [System.Windows.Automation.ElementNotAvailableException] {
  } catch [System.Runtime.InteropServices.COMException] {
  }
  return $null
}

function Wait-ForMainWindow([System.Diagnostics.Process]$process, [string]$label) {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline) {
    $process.Refresh()
    if ($process.HasExited) { throw "${label}: File Manager exited before creating its main window (exit code $($process.ExitCode))." }
    foreach ($window in [RibbonGuiNative]::GetProcessWindows($process.Id)) {
      if (-not $window.IsVisible) { continue }
      $element = Get-VerifiedWindowElement $window $process.Id
      if ($null -ne $element -and $window.Handle -eq $process.MainWindowHandle) { return $window }
    }
    Start-Sleep -Milliseconds 250
  }
  throw "${label}: File Manager did not create a UI Automation top-level window within 20 seconds."
}

function Invoke-OptionsRegression([string]$arch, [string]$label, [string]$patchedFileManager, [string]$patchedDll, [int]$commandId) {
  $upstream = Join-Path $root ".build/upstream/$arch"
  $stage = Join-Path $temp "options-$arch-$($label -replace '[^a-zA-Z0-9-]', '-')"
  Copy-Item -LiteralPath $upstream -Destination $stage -Recurse -Force
  if ($patchedFileManager) { Copy-Item -LiteralPath $patchedFileManager -Destination (Join-Path $stage '7zFM.exe') -Force }
  if ($patchedDll) { Copy-Item -LiteralPath $patchedDll -Destination (Join-Path $stage '7z.dll') -Force }

  $process = $null
  $startedAt = Get-Date
  try {
    $process = Start-Process -FilePath (Join-Path $stage '7zFM.exe') -WorkingDirectory $stage -PassThru -ErrorAction Stop
    $main = Wait-ForMainWindow $process "$arch/$label"
    if (-not [RibbonGuiNative]::PostOptionsCommand($main.Handle, $commandId)) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "${arch}/${label}: PostMessage(WM_COMMAND, $commandId) failed with Win32 error $errorCode."
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $dialog = $null
    while ([DateTime]::UtcNow -lt $deadline) {
      $process.Refresh()
      if ($process.HasExited) { throw "${arch}/${label}: File Manager exited after Tools > Options was invoked (exit code $($process.ExitCode))." }
      foreach ($window in [RibbonGuiNative]::GetProcessWindows($process.Id)) {
        if (-not $window.IsVisible -or $window.Handle -eq $main.Handle -or $window.Title -notmatch 'Options') { continue }
        if ($null -ne (Get-VerifiedWindowElement $window $process.Id)) { $dialog = $window; break }
      }
      if ($null -ne $dialog) { break }
      Start-Sleep -Milliseconds 250
    }
    if ($null -eq $dialog) { throw "${arch}/${label}: Tools > Options did not create an Options dialog within 15 seconds." }

    $process.Refresh()
    if ($process.HasExited) { throw "${arch}/${label}: File Manager exited while the Options dialog was open (exit code $($process.ExitCode))." }
    Write-Host "${arch}/${label}: Tools > Options opened UI Automation window '$($dialog.Title)' (command ID $commandId); File Manager remained running."
    if (-not [RibbonGuiNative]::CloseDialog($dialog.Handle)) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "${arch}/${label}: closing the Options dialog with WM_CLOSE failed with Win32 error $errorCode."
    }
    $closeDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $closeDeadline) {
      $process.Refresh()
      if ($process.HasExited) { throw "${arch}/${label}: File Manager exited after the Options dialog was dismissed (exit code $($process.ExitCode))." }
      $stillOpen = @([RibbonGuiNative]::GetProcessWindows($process.Id) | Where-Object { $_.Handle -eq $dialog.Handle -and $_.IsVisible }).Count -gt 0
      if (-not $stillOpen) { break }
      Start-Sleep -Milliseconds 100
    }
    if ($stillOpen) { throw "${arch}/${label}: Options dialog did not close after WM_CLOSE." }
    Write-Host "${arch}/${label}: Options dialog dismissed without editing settings; File Manager stayed running."
  } catch {
    if ($null -ne $process) {
      $process.Refresh()
      if ($process.HasExited) { Write-Error "${arch}/${label}: process terminated with exit code $($process.ExitCode)." -ErrorAction Continue }
    }
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $startedAt; Id = 1000, 1001 } -ErrorAction SilentlyContinue | Select-Object -First 4)
    foreach ($event in $events) { Write-Warning "Application event $($event.Id) at $($event.TimeCreated): $($event.Message -replace '\s+', ' ')" }
    throw
  } finally {
    if ($null -ne $process) {
      try {
        $process.Refresh()
        if (-not $process.HasExited) {
          Stop-Process -Id $process.Id -Force -ErrorAction Stop
          [void]$process.WaitForExit(5000)
        }
      } catch { Write-Warning "Unable to cleanly terminate Options test process $($process.Id): $_" }
      $process.Dispose()
    }
  }
}

try {
  $commandPath = Join-Path $root '.build/gui-options-command.json'
  if (-not (Test-Path -LiteralPath $commandPath -PathType Leaf)) { throw 'Missing menu command derived from the pinned official 7zFM.exe; run the build first.' }
  $command = Get-Content -LiteralPath $commandPath -Raw | ConvertFrom-Json
  $optionsCommandId = [int]$command.commandId
  if ($optionsCommandId -lt 1 -or $optionsCommandId -gt 0xffff) { throw "Invalid Tools > Options command ID $optionsCommandId." }

  foreach ($arch in @('x86', 'x64')) {
    $upstream = Join-Path $root ".build/upstream/$arch"
    if (-not (Test-Path (Join-Path $upstream '7zFM.exe'))) {
      throw "Missing official 7zFM.exe for $arch"
    }

    if ($BaselineOnly) {
      if (-not $LegacyRibbonRoot) { throw '-BaselineOnly requires -LegacyRibbonRoot so the existing resedit patch can be compared with the official control.' }
      $legacy = Join-Path (Resolve-Path -LiteralPath $LegacyRibbonRoot).Path (Join-Path $arch "$($manifest.ribbon.slug)/7zFM.exe")
      if (-not (Test-Path -LiteralPath $legacy -PathType Leaf)) { throw "Missing existing Ribbon executable for ${arch}: $legacy" }
      Invoke-OptionsRegression $arch 'official baseline' $null $null $optionsCommandId
      Invoke-OptionsRegression $arch 'existing resedit Ribbon' $legacy $null $optionsCommandId
      continue
    }

    Invoke-OptionsRegression $arch 'official baseline' $null $null $optionsCommandId
    if ($LegacyRibbonRoot) {
      $legacy = Join-Path (Resolve-Path -LiteralPath $LegacyRibbonRoot).Path (Join-Path $arch "$($manifest.ribbon.slug)/7zFM.exe")
      if (-not (Test-Path -LiteralPath $legacy -PathType Leaf)) { throw "Missing existing Ribbon executable for ${arch}: $legacy" }
      Invoke-OptionsRegression $arch 'existing resedit Ribbon' $legacy $null $optionsCommandId
    }
    $nativeRibbon = Join-Path $root ".build/packages/$arch/$($manifest.ribbon.slug)/7zFM.exe"
    if (-not (Test-Path -LiteralPath $nativeRibbon -PathType Leaf)) { throw "Missing native Ribbon executable for ${arch}: $nativeRibbon" }
    Invoke-OptionsRegression $arch 'native Ribbon' $nativeRibbon $null $optionsCommandId
    foreach ($filetype in $manifest.filetypes) {
      $themedDll = Join-Path $root ".build/packages/$arch/$($filetype.slug)/7z.dll"
      if (-not (Test-Path -LiteralPath $themedDll -PathType Leaf)) { throw "Missing themed DLL for $arch/$($filetype.slug): $themedDll" }
      Invoke-OptionsRegression $arch "official File Manager with $($filetype.name) DLL" $null $themedDll $optionsCommandId
      Invoke-OptionsRegression $arch "native Ribbon with $($filetype.name) DLL" $nativeRibbon $themedDll $optionsCommandId
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
  if (-not $BaselineOnly) {
    $reportPath = Join-Path $root 'reports/generated/resource-diff.json'
    if (Test-Path -LiteralPath $reportPath -PathType Leaf) {
      $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
      foreach ($result in $report.results) {
        if ($result.theme -eq $manifest.ribbon.name) { $result.functionalTests.status = 'passed-x86-x64-tools-options-dialog' }
      }
      $json = ConvertTo-Json -InputObject $report -Depth 100
      [IO.File]::WriteAllText($reportPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    }
  }
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

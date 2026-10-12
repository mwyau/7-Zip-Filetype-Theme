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

    [DllImport("user32.dll", EntryPoint = "SendMessageW", ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SendMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

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

    public static void ClickButton(IntPtr button)
    {
        SendMessageW(button, 0x00F5, IntPtr.Zero, IntPtr.Zero);
    }

    public static int GetTabCount(IntPtr tabControl)
    {
        return SendMessageW(tabControl, 0x1304, IntPtr.Zero, IntPtr.Zero).ToInt32();
    }

    public static int GetSelectedTab(IntPtr tabControl)
    {
        return SendMessageW(tabControl, 0x130B, IntPtr.Zero, IntPtr.Zero).ToInt32();
    }

    public static void MoveTab(IntPtr tabControl, bool next)
    {
        IntPtr key = new IntPtr(next ? 0x27 : 0x25);
        SendMessageW(tabControl, 0x0100, key, IntPtr.Zero);
        SendMessageW(tabControl, 0x0101, key, IntPtr.Zero);
    }

}
'@
Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -Raw (Join-Path $root 'config/themes.json') | ConvertFrom-Json
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

function Get-OptionsTabControl([System.Windows.Automation.AutomationElement]$dialogElement) {
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty,
    'SysTabControl32')
  return @($dialogElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
}

function Write-OptionsAutomationTree([System.Windows.Automation.AutomationElement]$dialogElement) {
  $all = $dialogElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($element in $all) {
    try {
      $patterns = @($element.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ','
      Write-Host "Options UIA: $($element.Current.ControlType.ProgrammaticName) name='$($element.Current.Name)' id='$($element.Current.AutomationId)' class='$($element.Current.ClassName)' patterns='$patterns'"
    } catch { }
  }
}

function Assert-ProcessAlive([System.Diagnostics.Process]$process, [string]$label, [string]$activity) {
  $process.Refresh()
  if ($process.HasExited) {
    throw "${label}: File Manager exited $activity (exit code $($process.ExitCode))."
  }
}

function Get-VisibleOptionsPageName([System.Windows.Automation.AutomationElement]$dialogElement) {
  $all = $dialogElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($element in $all) {
    try {
      if ($element.Current.ClassName -eq '#32770' -and -not [string]::IsNullOrWhiteSpace($element.Current.Name)) {
        return [string]$element.Current.Name
      }
    } catch [System.Windows.Automation.ElementNotAvailableException] { }
  }
  return $null
}

function Wait-ForTabIndex([IntPtr]$tabHandle, [int]$expected, [System.Diagnostics.Process]$process, [string]$label) {
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  while ([DateTime]::UtcNow -lt $deadline) {
    Assert-ProcessAlive $process $label "while selecting Options tab index $expected"
    $selected = [RibbonGuiNative]::GetSelectedTab($tabHandle)
    if ($selected -eq $expected) { return $selected }
    Start-Sleep -Milliseconds 100
  }
  return [RibbonGuiNative]::GetSelectedTab($tabHandle)
}

function Select-AndVerifyOptionsTabs([System.Windows.Automation.AutomationElement]$dialogElement, [System.Diagnostics.Process]$process, [string]$label) {
  $tabControls = @(Get-OptionsTabControl $dialogElement)
  if ($tabControls.Count -ne 1) {
    Write-OptionsAutomationTree $dialogElement
    throw "${label}: expected one UI Automation-discovered SysTabControl32 in Options; found $($tabControls.Count)."
  }
  $tabControl = $tabControls[0]
  $tabHandle = [IntPtr]$tabControl.Current.NativeWindowHandle
  if ($tabHandle -eq [IntPtr]::Zero) { throw "${label}: UI Automation tab control did not expose its native handle." }
  $tabCount = [RibbonGuiNative]::GetTabCount($tabHandle)
  if ($tabCount -lt 1) { throw "${label}: the Options tab control contains no tabs." }
  # 7-Zip exposes its common tab control to UI Automation as a Pane without TabItem or SelectionItem patterns.
  # UI Automation locates the control; this 7-Zip build exposes it as a Pane that cannot receive focus
  # and has no TabItem/SelectionItem patterns. Send the standard arrow key to that control, verify with
  # the scalar TCM_GETCURSEL message, and read the active page label from the UI Automation tree.
  $currentIndex = [RibbonGuiNative]::GetSelectedTab($tabHandle)
  if ($currentIndex -lt 0 -or $currentIndex -ge $tabCount) { throw "${label}: Options has invalid current tab index $currentIndex." }
  while ($currentIndex -gt 0) {
    Assert-ProcessAlive $process $label 'while navigating to the first Options tab'
    [RibbonGuiNative]::MoveTab($tabHandle, $false)
    $previousIndex = $currentIndex
    $currentIndex = Wait-ForTabIndex $tabHandle ($previousIndex - 1) $process $label
    if ($currentIndex -ge $previousIndex) { throw "${label}: keyboard navigation did not move to the preceding Options tab." }
  }

  $tabNames = @()
  for ($index = 0; $index -lt $tabCount; $index++) {
    if ($index -gt 0) {
      Assert-ProcessAlive $process $label "while selecting Options tab index $index"
      [RibbonGuiNative]::MoveTab($tabHandle, $true)
      $currentIndex = Wait-ForTabIndex $tabHandle $index $process $label
    }
    $currentIndex = [RibbonGuiNative]::GetSelectedTab($tabHandle)
    if ($currentIndex -ne $index) { throw "${label}: tab index $index was not selected (current index $currentIndex)." }
    $pageName = Get-VisibleOptionsPageName $dialogElement
    if ([string]::IsNullOrWhiteSpace($pageName)) { $pageName = "Tab $index" }
    $tabNames += $pageName
    Assert-ProcessAlive $process $label "after selecting and verifying Options tab '$pageName'"
    Write-Host "${label}: selected and verified Options tab '$pageName' ($($index + 1)/$tabCount)."
  }
  return $tabNames
}

function Close-OptionsWithoutSaving([System.Windows.Automation.AutomationElement]$dialogElement, [RibbonGuiWindow]$dialog, [System.Diagnostics.Process]$process, [string]$label) {
  $condition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty,
    'Button')
  $buttons = @($dialogElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
  $cancelButtons = @($buttons | Where-Object { $_.Current.Name -eq 'Cancel' -and $_.Current.IsEnabled })
  if ($cancelButtons.Count -ne 1) { throw "${label}: expected one enabled UI Automation Cancel button to dismiss Options without saving; found $($cancelButtons.Count)." }
  try {
    $cancelHandle = [IntPtr]$cancelButtons[0].Current.NativeWindowHandle
    if ($cancelHandle -eq [IntPtr]::Zero) { throw 'UI Automation Cancel element has no native button handle.' }
    [RibbonGuiNative]::ClickButton($cancelHandle)
  } catch {
    throw "${label}: UI Automation could not activate Cancel; refusing to close Options through a save-capable action: $_"
  }

  $closeDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $closeDeadline) {
    Assert-ProcessAlive $process $label 'after Options was canceled'
    $stillOpen = @([RibbonGuiNative]::GetProcessWindows($process.Id) | Where-Object { $_.Handle -eq $dialog.Handle -and $_.IsVisible }).Count -gt 0
    if (-not $stillOpen) { break }
    Start-Sleep -Milliseconds 100
  }
  if ($stillOpen) { throw "${label}: Options dialog did not close after invoking Cancel." }
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
    $dialogElement = Get-VerifiedWindowElement $dialog $process.Id
    if ($null -eq $dialogElement) { throw "${arch}/${label}: Options dialog lost its UI Automation Window element." }
    $tabNames = @(Select-AndVerifyOptionsTabs $dialogElement $process "${arch}/${label}")
    Write-Host "${arch}/${label}: Tools > Options opened (command ID $commandId), and all $($tabNames.Count) discovered tabs were selected and verified."
    Close-OptionsWithoutSaving $dialogElement $dialog $process "${arch}/${label}"
    Write-Host "${arch}/${label}: Options canceled without saving; File Manager stayed running."
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
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction Stop }
        if (-not $process.WaitForExit(5000)) { throw "Options test process $($process.Id) remained alive after cleanup." }
      } finally { $process.Dispose() }
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

    Invoke-OptionsRegression $arch 'official baseline' $null $null $optionsCommandId
    $nativeRibbon = Join-Path $root ".build/packages/$arch/$($manifest.ribbon.slug)/7zFM.exe"
    if (-not (Test-Path -LiteralPath $nativeRibbon -PathType Leaf)) { throw "Missing native Ribbon executable for ${arch}: $nativeRibbon" }
    Invoke-OptionsRegression $arch 'native Ribbon' $nativeRibbon $null $optionsCommandId
    foreach ($filetype in $manifest.filetypes) {
      $themedDll = Join-Path $root ".build/packages/$arch/$($filetype.slug)/7z.dll"
      if (-not (Test-Path -LiteralPath $themedDll -PathType Leaf)) { throw "Missing themed DLL for $arch/$($filetype.slug): $themedDll" }
      Invoke-OptionsRegression $arch "official File Manager with $($filetype.name) DLL" $null $themedDll $optionsCommandId
      Invoke-OptionsRegression $arch "native Ribbon with $($filetype.name) DLL" $nativeRibbon $themedDll $optionsCommandId
    }
  }

  $reportPath = Join-Path $root 'reports/generated/resource-diff.json'
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) { throw 'Missing resource report; refusing to mark GUI smoke as passed.' }
  $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  foreach ($result in $report.results) {
    if ($result.theme -eq $manifest.ribbon.name) {
      $result.functionalTests.status = 'passed-x86-x64-package-integrity; passed-x86-x64-options-tabs'
    } else {
      $statusParts = @(([string]$result.functionalTests.status -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique))
      if ($statusParts -notcontains 'passed-x86-x64-options-tabs') { $statusParts += 'passed-x86-x64-options-tabs' }
      $result.functionalTests.status = $statusParts -join '; '
    }
  }
  $json = ConvertTo-Json -InputObject $report -Depth 100
  [IO.File]::WriteAllText($reportPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

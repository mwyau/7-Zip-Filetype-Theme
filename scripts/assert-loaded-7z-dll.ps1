param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(Mandatory = $true)][string]$ExpectedDll
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$nativeSource = @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct NativeModuleEntry
{
    public uint dwSize;
    public uint th32ModuleID;
    public uint th32ProcessID;
    public uint GlblcntUsage;
    public uint ProccntUsage;
    public IntPtr modBaseAddr;
    public uint modBaseSize;
    public IntPtr hModule;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szModule;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExePath;
}

public static class NativeModuleSnapshot
{
    private const uint TH32CS_SNAPMODULE = 0x00000008;
    private const uint TH32CS_SNAPMODULE32 = 0x00000010;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [DllImport("kernel32.dll", EntryPoint = "CreateToolhelp32Snapshot", ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", EntryPoint = "Module32FirstW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Module32FirstW(IntPtr snapshot, ref NativeModuleEntry entry);
    [DllImport("kernel32.dll", EntryPoint = "Module32NextW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Module32NextW(IntPtr snapshot, ref NativeModuleEntry entry);
    [DllImport("kernel32.dll", EntryPoint = "CloseHandle", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    public static string FindModulePath(uint processId, string moduleName)
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, processId);
        if (snapshot == InvalidHandle) return null;
        try
        {
            NativeModuleEntry entry = new NativeModuleEntry();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(NativeModuleEntry));
            if (!Module32FirstW(snapshot, ref entry)) return null;
            do
            {
                if (String.Equals(entry.szModule, moduleName, StringComparison.OrdinalIgnoreCase)) return entry.szExePath;
                entry.dwSize = (uint)Marshal.SizeOf(typeof(NativeModuleEntry));
            } while (Module32NextW(snapshot, ref entry));
            return null;
        }
        finally { CloseHandle(snapshot); }
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
$exePath = (Resolve-Path -LiteralPath $Executable).Path
$workingPath = (Resolve-Path -LiteralPath $WorkingDirectory).Path
$expectedPath = [IO.Path]::GetFullPath($ExpectedDll)
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $exePath
$start.Arguments = 'b 1'
$start.WorkingDirectory = $workingPath
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start

try {
  if (-not $process.Start()) { throw '7z.exe did not start for the module-load check.' }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $loadedPath = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    $process.Refresh()
    if ($process.HasExited) { break }
    $loadedPath = [NativeModuleSnapshot]::FindModulePath([uint32]$process.Id, '7z.dll')
    if ($loadedPath) { break }
    Start-Sleep -Milliseconds 100
  }
  if (-not $loadedPath) {
    $process.Refresh()
    if (-not $process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }
    $output = $stdoutTask.GetAwaiter().GetResult() + $stderrTask.GetAwaiter().GetResult()
    throw "7z.exe did not expose a loaded 7z.dll module within 20 seconds. $output"
  }
  if (-not [string]::Equals([IO.Path]::GetFullPath($loadedPath), $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "7z.exe loaded '$loadedPath' instead of the staged DLL '$expectedPath'."
  }
  $process.Kill()
  [void]$process.WaitForExit(5000)
  Write-Output "observed loaded module at '$loadedPath'"
} finally {
  $process.Refresh()
  if (-not $process.HasExited) {
    try { $process.Kill(); [void]$process.WaitForExit(5000) } catch { }
  }
  $process.Dispose()
}

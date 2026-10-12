param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$Manifest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$executablePath = [IO.Path]::GetFullPath($Executable)
$manifestPath = (Resolve-Path -LiteralPath $Manifest).Path
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
  throw "Staged executable does not exist: $executablePath"
}

$manifestData = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$resources = @($manifestData.resources)
if ($resources.Count -eq 0) {
  throw 'The Ribbon update manifest contains no resources.'
}

$resourceIds = [int[]]@($resources | ForEach-Object { [int]$_.id })
$languages = [int[]]@($resources | ForEach-Object { [int]$_.language })
$payloadPaths = [string[]]@($resources | ForEach-Object { [IO.Path]::GetFullPath([string]$_.path) })
if ($resourceIds.Length -ne $resources.Count -or
    $languages.Length -ne $resources.Count -or
    $payloadPaths.Length -ne $resources.Count) {
  throw 'The Ribbon update manifest has inconsistent resource fields.'
}

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class RibbonNativeResourceWriter
{
    [DllImport("kernel32.dll", EntryPoint = "BeginUpdateResourceW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr BeginUpdateResourceW(string fileName, [MarshalAs(UnmanagedType.Bool)] bool deleteExistingResources);

    [DllImport("kernel32.dll", EntryPoint = "UpdateResourceW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateResourceW(IntPtr updateHandle, IntPtr type, IntPtr name, ushort language, [In] byte[] data, uint dataSize);

    [DllImport("kernel32.dll", EntryPoint = "EndUpdateResourceW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EndUpdateResourceW(IntPtr updateHandle, [MarshalAs(UnmanagedType.Bool)] bool discard);

    private static IntPtr ResourceId(int id)
    {
        return new IntPtr(id);
    }

    private static Win32Exception NativeError(string operation, int error)
    {
        return new Win32Exception(error, operation + " failed with Win32 error " + error + ": " + new Win32Exception(error).Message);
    }

    public static void Apply(string executable, int[] ids, int[] languages, string[] payloadPaths)
    {
        if (ids == null || languages == null || payloadPaths == null || ids.Length == 0 ||
            ids.Length != languages.Length || ids.Length != payloadPaths.Length)
        {
            throw new ArgumentException("Resource IDs, languages, and payload paths must have the same nonzero length.");
        }

        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < ids.Length; index++)
        {
            if (ids[index] < 1 || ids[index] > 0xffff) throw new ArgumentOutOfRangeException("ids", "Resource IDs must be numeric ordinals in the range 1–65535.");
            if (languages[index] < 0 || languages[index] > 0xffff) throw new ArgumentOutOfRangeException("languages", "Resource languages must be in the range 0–65535.");
            string key = "2:" + ids[index] + ":" + languages[index];
            if (!seen.Add(key)) throw new ArgumentException("Duplicate resource update: " + key);
            if (String.IsNullOrWhiteSpace(payloadPaths[index]) || !File.Exists(payloadPaths[index])) throw new FileNotFoundException("Bitmap payload does not exist.", payloadPaths[index]);
        }

        IntPtr handle = BeginUpdateResourceW(executable, false);
        if (handle == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            throw NativeError("BeginUpdateResourceW for " + executable, error);
        }

        try
        {
            for (int index = 0; index < ids.Length; index++)
            {
                byte[] data = File.ReadAllBytes(payloadPaths[index]);
                if (data.Length == 0) throw new InvalidDataException("Empty RT_BITMAP payload for ID " + ids[index] + ".");
                string context = "UpdateResourceW RT_BITMAP/" + ids[index] + "/" + languages[index];
                if (!UpdateResourceW(handle, ResourceId(2), ResourceId(ids[index]), (ushort)languages[index], data, (uint)data.Length))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw NativeError(context, error);
                }
            }

            if (!EndUpdateResourceW(handle, false))
            {
                int error = Marshal.GetLastWin32Error();
                throw NativeError("EndUpdateResourceW commit for " + executable, error);
            }
            handle = IntPtr.Zero;
        }
        catch (Exception updateError)
        {
            if (handle != IntPtr.Zero)
            {
                if (!EndUpdateResourceW(handle, true))
                {
                    int rollbackError = Marshal.GetLastWin32Error();
                    throw new InvalidOperationException(updateError.Message + " Rollback with EndUpdateResourceW(discard: true) also failed with Win32 error " + rollbackError + ": " + new Win32Exception(rollbackError).Message, updateError);
                }
                handle = IntPtr.Zero;
            }
            throw;
        }
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
[RibbonNativeResourceWriter]::Apply($executablePath, $resourceIds, $languages, $payloadPaths)
Write-Output "Updated $($resources.Count) RT_BITMAP resources in the staged executable using Win32 resource APIs."

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

$manifestText = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8)
$manifestData = $manifestText | ConvertFrom-Json
$operations = @($manifestData.operations)
if ($operations.Count -eq 0) {
  throw 'The native resource update manifest contains no operations.'
}

$types = [int[]]@($operations | ForEach-Object { [int]$_.type })
$ids = [string[]]@($operations | ForEach-Object { [string]$_.id })
$idKinds = [string[]]@($operations | ForEach-Object { if ($_.id -is [string]) { 'name' } else { 'ordinal' } })
$languages = [int[]]@($operations | ForEach-Object { [int]$_.language })
$actions = [string[]]@($operations | ForEach-Object { [string]$_.action })
$payloadPaths = [string[]]@($operations | ForEach-Object {
  if ([string]$_.action -ceq 'update') { [IO.Path]::GetFullPath([string]$_.path) } else { '' }
})
if ($types.Length -ne $operations.Count -or $ids.Length -ne $operations.Count -or
    $idKinds.Length -ne $operations.Count -or $languages.Length -ne $operations.Count -or $actions.Length -ne $operations.Count -or
    $payloadPaths.Length -ne $operations.Count) {
  throw 'The native resource manifest has inconsistent operation fields.'
}

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class NativeResourceWriter
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
        return new IntPtr((long)id);
    }

    private static Win32Exception NativeError(string operation, int error)
    {
        return new Win32Exception(error, operation + " failed with Win32 error " + error + ": " + new Win32Exception(error).Message);
    }

    private static bool IsSupportedType(int type)
    {
        return type == 2 || type == 3 || type == 14;
    }

    public static void Apply(string executable, int[] types, string[] ids, string[] idKinds, int[] languages, string[] actions, string[] payloadPaths)
    {
        if (types == null || ids == null || idKinds == null || languages == null || actions == null || payloadPaths == null || types.Length == 0 ||
            types.Length != ids.Length || types.Length != idKinds.Length || types.Length != languages.Length || types.Length != actions.Length || types.Length != payloadPaths.Length)
        {
            throw new ArgumentException("Native resource operation arrays must have the same nonzero length.");
        }

        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < types.Length; index++)
        {
            if (!IsSupportedType(types[index])) throw new ArgumentOutOfRangeException("types", "Only RT_BITMAP (2), RT_ICON (3), and RT_GROUP_ICON (14) are supported.");
            int ordinal = -1;
            if (idKinds[index] == "ordinal")
            {
                if (!Int32.TryParse(ids[index], out ordinal) || ordinal < 1 || ordinal > 0xffff) throw new ArgumentOutOfRangeException("ids", "Numeric resource ordinals must be in the range 1–65535; ordinal zero is a null pointer to Win32 resource APIs.");
            }
            else if (idKinds[index] == "name")
            {
                if (String.IsNullOrEmpty(ids[index]) || ids[index].Length > 255 || ids[index].IndexOf('\0') >= 0) throw new ArgumentException("Named resource IDs must be 1–255 Unicode characters without NUL.");
            }
            else throw new ArgumentException("Resource ID kind must be ordinal or name.");
            if (languages[index] < 0 || languages[index] > 0xffff) throw new ArgumentOutOfRangeException("languages", "Resource languages must be in the range 0–65535.");
            if (actions[index] != "update" && actions[index] != "delete") throw new ArgumentException("Resource action must be update or delete.");
            string key = types[index] + ":" + idKinds[index] + ":" + ids[index] + ":" + languages[index];
            if (!seen.Add(key)) throw new ArgumentException("Duplicate native resource operation: " + key);
            if (actions[index] == "update")
            {
                if (String.IsNullOrWhiteSpace(payloadPaths[index]) || !File.Exists(payloadPaths[index])) throw new FileNotFoundException("Resource payload does not exist.", payloadPaths[index]);
                if (new FileInfo(payloadPaths[index]).Length == 0) throw new InvalidDataException("Empty resource payload for " + key + ".");
            }
            else if (!String.IsNullOrEmpty(payloadPaths[index]))
            {
                throw new ArgumentException("Delete operation " + key + " must not have a payload path.");
            }
        }

        IntPtr handle = BeginUpdateResourceW(executable, false);
        if (handle == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            throw NativeError("BeginUpdateResourceW for " + executable, error);
        }

        try
        {
            for (int index = 0; index < types.Length; index++)
            {
                byte[] data = actions[index] == "update" ? File.ReadAllBytes(payloadPaths[index]) : null;
                if (actions[index] == "update" && data.Length == 0) throw new InvalidDataException("Empty resource payload for " + types[index] + "/" + ids[index] + ".");
                uint dataSize = data == null ? 0u : (uint)data.Length;
                string context = "UpdateResourceW type " + types[index] + "/" + ids[index] + "/" + languages[index] + " (" + actions[index] + ")";
                IntPtr resourceName = IntPtr.Zero;
                bool allocatedName = false;
                if (idKinds[index] == "ordinal") resourceName = ResourceId(Int32.Parse(ids[index]));
                else { resourceName = Marshal.StringToHGlobalUni(ids[index]); allocatedName = true; }
                bool updated;
                try { updated = UpdateResourceW(handle, ResourceId(types[index]), resourceName, (ushort)languages[index], data, dataSize); }
                finally { if (allocatedName) Marshal.FreeHGlobal(resourceName); }
                if (!updated)
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
[NativeResourceWriter]::Apply($executablePath, $types, $ids, $idKinds, $languages, $actions, $payloadPaths)
Write-Output "Applied $($operations.Count) native resource operations to the staged PE using one Win32 transaction."

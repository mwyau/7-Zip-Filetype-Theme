param(
  [Parameter(Mandatory = $true)][string]$Dll,
  [string[]]$GroupIds = @('0', '1', '13', '26')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class NativeIconResourceSmoke
{
    private const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;
    private const uint LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x00000020;
    private const uint IMAGE_ICON = 1;

    [DllImport("kernel32.dll", EntryPoint = "LoadLibraryExW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr LoadLibraryExW(string fileName, IntPtr file, uint flags);
    [DllImport("kernel32.dll", EntryPoint = "FreeLibrary", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeLibrary(IntPtr module);
    [DllImport("user32.dll", EntryPoint = "LoadImageW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr LoadImageW(IntPtr module, IntPtr name, uint type, int width, int height, uint flags);
    [DllImport("user32.dll", EntryPoint = "DestroyIcon", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr icon);

    public static void Validate(string dll, string[] groupIds)
    {
        IntPtr module = LoadLibraryExW(dll, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
        if (module == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            throw new Win32Exception(error, "LoadLibraryExW as data/image resource failed with Win32 error " + error + ": " + new Win32Exception(error).Message);
        }
        try
        {
            foreach (string groupId in groupIds)
            {
                bool named = groupId == "0";
                IntPtr resourceName = named ? Marshal.StringToHGlobalUni(groupId) : new IntPtr(Int32.Parse(groupId));
                try
                {
                    IntPtr icon = LoadImageW(module, resourceName, IMAGE_ICON, 32, 32, 0);
                    if (icon == IntPtr.Zero)
                    {
                        int error = Marshal.GetLastWin32Error();
                        throw new Win32Exception(error, "LoadImageW RT_GROUP_ICON/" + (named ? "name:" : "ordinal:") + groupId + " failed with Win32 error " + error + ": " + new Win32Exception(error).Message);
                    }
                    if (!DestroyIcon(icon))
                    {
                        int error = Marshal.GetLastWin32Error();
                        throw new Win32Exception(error, "DestroyIcon failed with Win32 error " + error + ": " + new Win32Exception(error).Message);
                    }
                }
                finally { if (named) Marshal.FreeHGlobal(resourceName); }
            }
        }
        finally { FreeLibrary(module); }
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
$dllPath = (Resolve-Path -LiteralPath $Dll).Path
[NativeIconResourceSmoke]::Validate($dllPath, $GroupIds)
Write-Output "LoadImageW loaded RT_GROUP_ICON groups $($GroupIds -join ', ') from '$dllPath' as data-only resources."

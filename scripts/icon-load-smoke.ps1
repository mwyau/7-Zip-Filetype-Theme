param(
  [Parameter(Mandatory = $true)][string]$Dll
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

    public static void Validate(string dll)
    {
        IntPtr module = LoadLibraryExW(dll, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
        if (module == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            throw new Win32Exception(error, "LoadLibraryExW as data/image resource failed with Win32 error " + error + ": " + new Win32Exception(error).Message);
        }
        try
        {
            int[] sizes = new int[] { 16, 32, 48, 256 };
            for (int groupId = 0; groupId <= 26; groupId++)
            {
                bool named = groupId == 0;
                IntPtr resourceName = named ? Marshal.StringToHGlobalUni("0") : new IntPtr(groupId);
                try
                {
                    foreach (int size in sizes)
                    {
                        IntPtr icon = LoadImageW(module, resourceName, IMAGE_ICON, size, size, 0);
                        string label = "RT_GROUP_ICON/" + (named ? "name:" : "ordinal:") + groupId + " at " + size + "x" + size;
                        if (icon == IntPtr.Zero)
                        {
                            int error = Marshal.GetLastWin32Error();
                            throw new Win32Exception(error, "LoadImageW " + label + " failed with Win32 error " + error + ": " + new Win32Exception(error).Message);
                        }
                        if (!DestroyIcon(icon))
                        {
                            int error = Marshal.GetLastWin32Error();
                            throw new Win32Exception(error, "DestroyIcon for " + label + " failed with Win32 error " + error + ": " + new Win32Exception(error).Message);
                        }
                    }
                }
                finally { if (named) Marshal.FreeHGlobal(resourceName); }
            }
        }
        finally
        {
            if (!FreeLibrary(module))
            {
                int error = Marshal.GetLastWin32Error();
                throw new Win32Exception(error, "FreeLibrary failed with Win32 error " + error + ": " + new Win32Exception(error).Message);
            }
        }
    }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
$dllPath = (Resolve-Path -LiteralPath $Dll).Path
[NativeIconResourceSmoke]::Validate($dllPath)
Write-Output "LoadImageW loaded all RT_GROUP_ICON groups 0-26 at 16, 32, 48, and 256 pixels from '$dllPath' as data-only resources."
